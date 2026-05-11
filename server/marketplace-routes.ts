import type { Express } from "express";
import { storage } from "./storage";
import { z } from "zod";
import { randomUUID } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import {
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
  sendWelcomeEmail,
  sendBookingConfirmationEmail,
  sendWaitlistPromotionEmail,
  sendCancellationEmail,
  sendDisputeResolutionEmail,
  sendGuestBookingEmail,
  sendPlayerLinkOtpEmail,
  sendPlayerContactChangeOtpEmail,
  sendMarketplaceContactChangeOtpEmail,
} from "./emailClient";
import { isSmsConfigured, sendPlayerLinkOtpSms } from "./smsClient";
import { createHash, randomInt } from "crypto";
import { requireAuth, requireAdmin, requireMarketplaceAuth, type AuthRequest } from "./auth/middleware";
import {
  generateAccessToken,
  generateRefreshToken,
  comparePassword,
  hashPassword,
  verifyRefreshToken,
} from "./auth/utils";
import { createZiinaPaymentIntent, retrieveZiinaPaymentIntent, isZiinaPaymentSuccessful, registerZiinaWebhook, buildZiinaBookingMessage } from "./ziinaClient";
import { randomBytes } from "crypto";
import { confirmZiinaBookingByIntentId } from "./webhookHandler";
import { completeReferral } from "./referrals";
import { OAuth2Client } from "google-auth-library";
import { db } from "./db";
import { sql, eq, and, inArray, desc, asc, gt } from "drizzle-orm";
import { players, matchSuggestions, matchSuggestionPlayers, courts, sessions, bookings, bookableSessions, gameParticipants, gameResults, marketplaceUsers, bookingGuests } from "@shared/schema";
import { applyPendingSignupCredit, creditForPromo } from "./promos";
import {
  generateBracketedLineups,
  buildRestStatesFromHistory,
  buildPartnerHistoryFromHistory,
  updatePlayerRestState,
  updatePartnerHistory,
  persistRestStatesToDb,
} from "./matchmaking";
import { tryAutoMatchmaking, tryFlipQueuedToPendingForCourt } from "./auto-matchmaking";

// ─── Tier buffer helper (mirror of server/routes.ts:61 — keep in sync) ───────
// After each game, a player's confirmed level (stored in DB) only changes after
// 3 consecutive games where their skill score lands in the new tier.
// Until then, tierCandidate + tierCandidateGames track the trend.
function applyMarketplaceTierBuffer(
  player: { level: string; tierCandidate: string | null; tierCandidateGames: number },
  newScore: number,
  getSkillTierFn: (score: number) => string,
): { level: string; tierCandidate: string | null; tierCandidateGames: number } {
  const scoreTier = getSkillTierFn(newScore);
  const currentTier = player.level;

  if (scoreTier === currentTier) {
    return { level: currentTier, tierCandidate: null, tierCandidateGames: 0 };
  }

  const existingCandidate = player.tierCandidate;
  const existingCount = player.tierCandidateGames ?? 0;

  let newCandidate: string;
  let newCount: number;
  if (scoreTier === existingCandidate) {
    newCount = existingCount + 1;
    newCandidate = existingCandidate;
  } else {
    newCandidate = scoreTier;
    newCount = 1;
  }

  if (newCount >= 3) {
    return { level: scoreTier, tierCandidate: null, tierCandidateGames: 0 };
  }
  return { level: currentTier, tierCandidate: newCandidate, tierCandidateGames: newCount };
}

// Body schema for marketplace score submission
const submitScoreBodySchema = z.object({
  team1Score: z.number().int().min(0),
  team2Score: z.number().int().min(0),
  winningTeam: z.union([z.literal(1), z.literal(2)]),
});

// The single-court runP3BackgroundMatchmaking helper that lived here was
// replaced by the session-wide orchestrator in ./auto-matchmaking.ts which
// handles both the player-driven check-in fan-out and the score-submit
// follow-up for the just-vacated court.

// Mint a single-use payment-resume token and return the URL fragment to append
// to a Ziina success_url. Stored as SHA-256 hash, 30-min TTL. Returns an empty
// string if minting fails — we never want to break the payment flow over a
// non-essential session-restoration aid.
async function mintPaymentResumeParam(marketplaceUserId: string, bookingId: string): Promise<string> {
  try {
    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await storage.createPaymentResumeToken({ marketplaceUserId, bookingId, tokenHash, expiresAt });
    return `&resume=${raw}`;
  } catch (err) {
    console.error('[ResumeToken] Failed to mint resume token', { bookingId, error: err instanceof Error ? err.message : err });
    return '';
  }
}

async function refundBookingWalletCredit(booking: { walletAmountUsed: number | null; userId: string }) {
  if (!booking.walletAmountUsed || booking.walletAmountUsed <= 0) return;
  const user = await storage.getMarketplaceUser(booking.userId);
  if (!user?.linkedPlayerId) return;
  await db
    .update(players)
    .set({ walletBalance: sql`${players.walletBalance} + ${booking.walletAmountUsed}` })
    .where(eq(players.id, user.linkedPlayerId));
}

async function deductWalletForBooking(
  userId: string,
  bookingId: string,
  bookingAmountFils: number,
): Promise<{ walletApplied: number; remainingFils: number; error?: string }> {
  const booking = await storage.getBooking(bookingId);
  if (!booking || booking.userId !== userId) {
    return { walletApplied: 0, remainingFils: bookingAmountFils, error: 'Booking not found' };
  }
  if (booking.walletAmountUsed && booking.walletAmountUsed > 0) {
    return { walletApplied: booking.walletAmountUsed, remainingFils: bookingAmountFils - booking.walletAmountUsed };
  }
  const user = await storage.getMarketplaceUser(userId);
  if (!user?.linkedPlayerId) {
    return { walletApplied: 0, remainingFils: bookingAmountFils };
  }
  const player = await storage.getPlayer(user.linkedPlayerId);
  if (!player || player.walletBalance <= 0) {
    return { walletApplied: 0, remainingFils: bookingAmountFils };
  }
  const walletApplied = Math.min(player.walletBalance, bookingAmountFils);
  const [updated] = await db
    .update(players)
    .set({ walletBalance: sql`${players.walletBalance} - ${walletApplied}` })
    .where(and(eq(players.id, player.id), sql`${players.walletBalance} >= ${walletApplied}`))
    .returning();
  if (!updated) {
    return { walletApplied: 0, remainingFils: bookingAmountFils, error: 'Wallet balance changed' };
  }
  await storage.updateBooking(bookingId, { walletAmountUsed: walletApplied });
  return { walletApplied, remainingFils: bookingAmountFils - walletApplied };
}

// Compute starting skill score + level from the 3-question signup
// self-assessment. Each answer is 1-4 (sum range 3-12). Capped so new
// players cannot self-rank above upper_intermediate; Advanced and
// Professional are reserved for in-app earned promotions.
export function computeSkillFromAssessment(answers: [number, number, number]): {
  skillScore: number;
  level: 'Novice' | 'Beginner' | 'lower_intermediate' | 'upper_intermediate';
} {
  const sum = answers[0] + answers[1] + answers[2];
  if (sum <= 4) return { skillScore: 35, level: 'Novice' };
  if (sum <= 7) return { skillScore: 55, level: 'Beginner' };
  if (sum <= 10) return { skillScore: 75, level: 'lower_intermediate' };
  return { skillScore: 95, level: 'upper_intermediate' };
}

// Brand-guidelines display name for a tier. The DB stores a mix of
// capitalised tiers ('Novice', 'Beginner', 'Advanced', 'Professional') and
// snake_case mid-tiers ('lower_intermediate', 'upper_intermediate'); we
// normalise on lower-case before mapping. Player-facing copy must NEVER
// surface the raw snake_case values.
function tierDisplayName(level: string): string {
  const normalized = (level ?? '').toLowerCase();
  switch (normalized) {
    case 'novice': return 'Novice';
    case 'beginner': return 'Beginner';
    case 'lower_intermediate': return 'Intermediate';
    case 'upper_intermediate': return 'Competitive';
    case 'advanced': return 'Advanced';
    case 'professional': return 'Professional';
    default:
      // Defensive: never leak raw DB values (snake_case or otherwise) to
      // player-facing copy. Log so we can spot rogue values in the data.
      console.warn(`[tierDisplayName] unknown level value: ${JSON.stringify(level)}`);
      return '—';
  }
}

export function registerMarketplaceRoutes(app: Express) {
  // One-time idempotent backfill: any marketplace user with a googleId is
  // considered email-verified (Google has already verified their address).
  void (async () => {
    try {
      const updated = await storage.backfillEmailVerifiedForGoogleUsers();
      if (updated > 0) {
        console.log(`[EmailVerification] Backfilled emailVerified=true for ${updated} Google-linked marketplace user(s).`);
      }
    } catch (err) {
      console.error('[EmailVerification] Backfill failed:', err);
    }
  })();

  // ============================================================
  // PUBLIC ANALYTICS (no auth required — aggregated data only)
  // ============================================================

  app.options("/api/public/analytics", (_req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.sendStatus(204);
  });

  app.get("/api/public/analytics", async (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    try {
      const { sessionId, from, to } = req.query as Record<string, string>;

      const fromDate = from ? new Date(from) : undefined;
      const toDate = to ? new Date(to) : undefined;

      if (fromDate && isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "Invalid 'from' date. Use ISO 8601 format (e.g. 2026-03-01)" });
      }
      if (toDate && isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "Invalid 'to' date. Use ISO 8601 format (e.g. 2026-04-01)" });
      }

      const data = await storage.getPublicAnalytics({
        sessionId: sessionId || undefined,
        from: fromDate,
        to: toDate,
      });

      res.json(data);
    } catch (error: unknown) {
      console.error("[Public Analytics] Error:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Failed to compute analytics" });
    }
  });

  // ============================================================
  // MARKETPLACE AUTH
  // ============================================================

  app.post("/api/marketplace/auth/signup", async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(6),
        name: z.string().min(1),
        phone: z.string().min(1, "Phone number is required"),
        gender: z.enum(['Male', 'Female'], {
          required_error: 'Gender is required',
          invalid_type_error: 'Gender must be Male or Female',
        }),
        assessmentAnswers: z
          .array(z.number().int().min(1).max(4))
          .length(3, 'Please answer all three skill questions'),
        referralCode: z.string().optional(),
        promo: z.string().optional(),
      });
      const { email, password, name, phone, gender, assessmentAnswers, referralCode, promo } = schema.parse(req.body);
      // Jersey promo gives the new signup AED 15 wallet credit. It is
      // ignored if a referral code is also used so credits don't stack.
      const promoCredit = referralCode ? 0 : creditForPromo(promo);

      // Compute starting skill server-side. Hard cap at 95 — Advanced /
      // Professional are earned through gameplay only.
      const { skillScore, level } = computeSkillFromAssessment(assessmentAnswers as [number, number, number]);

      const existing = await storage.getMarketplaceUserByEmail(email);
      if (existing) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const verificationToken = randomUUID().replace(/-/g, '');
      const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

      // Create marketplace user + linked internal player record atomically.
      const { user } = await storage.signupMarketplaceUserWithPlayer({
        userInsert: {
          email,
          passwordHash,
          name,
          phone: phone || null,
          linkedPlayerId: null,
          role: "player",
          pendingSignupCreditFils: promoCredit,
          emailVerified: false,
          emailVerificationToken: verificationToken,
          emailVerificationTokenExpiry: verificationExpiry,
        },
        playerInsert: {
          name,
          email,
          phone: phone || null,
          gender,
          level,
          skillScore,
        },
      });

      const payload = { userId: user.id, email: user.email, role: "marketplace_player" };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await storage.createMarketplaceAuthSession(user.id, refreshToken, expiresAt);

      res.json({
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, phone: user.phone, linkedPlayerId: user.linkedPlayerId, photoUrl: user.photoUrl },
      });

      // Retroactive guest linking: link any prior guest records with this email to the new user
      storage.linkGuestsByEmail(user.email, user.id).catch(() => {});

      // Handle referral code linking and welcome email (fire-and-forget)
      const marketplaceUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}/marketplace`
        : 'http://localhost:5000/marketplace';

      (async () => {
        let referrerName: string | undefined;
        if (referralCode) {
          try {
            const referrer = await storage.getPlayerByReferralCode(referralCode.toUpperCase());
            if (referrer) {
              referrerName = referrer.name;
              const existingRef = await storage.getReferralByRefereeUserId(user.id);
              if (!existingRef) {
                await storage.createReferral({
                  referrerId: referrer.id,
                  refereeUserId: user.id,
                  refereePlayerId: null,
                  status: 'pending',
                });
                console.log(`[Referral] Linked ${user.email} to referrer ${referrer.name} (${referralCode})`);
              }
            }
          } catch (err) {
            console.error('[Referral] Signup link error:', err);
          }
        }
        sendWelcomeEmail(user.email, user.name, marketplaceUrl, referrerName).catch(() => {});
        const baseUrl = marketplaceUrl.replace(/\/marketplace$/, '');
        const verifyUrl = `${baseUrl}/marketplace/verify-email?token=${verificationToken}`;
        sendEmailVerificationEmail(user.email, user.name, verifyUrl).catch(() => {});
      })();
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      res.status(500).json({ error: "Signup failed" });
    }
  });

  // POST /api/marketplace/auth/complete-profile
  // For an authenticated marketplace user that has no linked player yet
  // (Google sign-up landing without going through the assessment), accept the
  // gender + 3-question assessment payload and atomically create the linked
  // player. Reuses computeSkillFromAssessment + the same SIQ-collision retry
  // logic as the email/password signup path.
  app.post(
    "/api/marketplace/auth/complete-profile",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const schema = z.object({
          gender: z.enum(['Male', 'Female'], {
            required_error: 'Gender is required',
            invalid_type_error: 'Gender must be Male or Female',
          }),
          assessmentAnswers: z
            .array(z.number().int().min(1).max(4))
            .length(3, 'Please answer all three skill questions'),
        });
        const { gender, assessmentAnswers } = schema.parse(req.body);

        const userId = req.user!.userId;
        const user = await storage.getMarketplaceUser(userId);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        if (user.linkedPlayerId) {
          return res.status(409).json({ error: "Profile already complete" });
        }

        const { skillScore, level } = computeSkillFromAssessment(
          assessmentAnswers as [number, number, number],
        );

        try {
          const { user: linkedUser, player } = await storage.createPlayerForExistingMarketplaceUser({
            userId,
            playerInsert: {
              name: user.name,
              email: user.email,
              phone: user.phone || null,
              gender,
              level,
              skillScore,
            },
          });

          res.json({
            user: {
              id: linkedUser.id,
              email: linkedUser.email,
              name: linkedUser.name,
              phone: linkedUser.phone,
              linkedPlayerId: linkedUser.linkedPlayerId,
              photoUrl: linkedUser.photoUrl,
            },
            player: { id: player.id, level: player.level, skillScore: player.skillScore },
          });
        } catch (err: any) {
          if (err?.message === 'PROFILE_ALREADY_COMPLETE') {
            return res.status(409).json({ error: "Profile already complete" });
          }
          if (err?.message === 'USER_NOT_FOUND') {
            return res.status(404).json({ error: "User not found" });
          }
          throw err;
        }
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('[complete-profile] error:', error);
        res.status(500).json({ error: "Failed to complete profile" });
      }
    },
  );

  // ============================================================
  // EMAIL VERIFICATION
  // ============================================================

  // In-memory rate limiter for verification email resends.
  const verificationSendTimestamps = new Map<string, number[]>();
  const VERIFICATION_MIN_INTERVAL_MS = 60 * 1000; // 60s between sends
  const VERIFICATION_HOURLY_LIMIT = 5;
  const VERIFICATION_HOURLY_WINDOW_MS = 60 * 60 * 1000;

  app.post("/api/marketplace/auth/send-verification", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getMarketplaceUser(req.user.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.emailVerified) {
        return res.json({ success: true, alreadyVerified: true });
      }

      const now = Date.now();
      const history = (verificationSendTimestamps.get(user.id) ?? []).filter(
        (t) => now - t < VERIFICATION_HOURLY_WINDOW_MS,
      );
      const last = history.length > 0 ? history[history.length - 1] : 0;
      if (last && now - last < VERIFICATION_MIN_INTERVAL_MS) {
        const retryAfter = Math.ceil((VERIFICATION_MIN_INTERVAL_MS - (now - last)) / 1000);
        return res.status(429).json({
          error: `Please wait ${retryAfter}s before requesting another verification email.`,
          retryAfter,
        });
      }
      if (history.length >= VERIFICATION_HOURLY_LIMIT) {
        return res.status(429).json({
          error: "Too many verification emails requested. Please try again later.",
        });
      }
      history.push(now);
      verificationSendTimestamps.set(user.id, history);

      const token = randomUUID().replace(/-/g, '');
      const expiry = new Date(now + 24 * 60 * 60 * 1000);
      await storage.updateMarketplaceUser(user.id, {
        emailVerificationToken: token,
        emailVerificationTokenExpiry: expiry,
      });

      const host = req.get('host') || 'localhost:5000';
      const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
      const verifyUrl = `${protocol}://${host}/marketplace/verify-email?token=${token}`;

      try {
        await sendEmailVerificationEmail(user.email, user.name, verifyUrl);
      } catch (emailErr) {
        console.error('[Email Verification] send failed:', emailErr);
        return res.status(500).json({ error: "Failed to send verification email" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[Email Verification] send error:', error);
      res.status(500).json({ error: "Failed to send verification email" });
    }
  });

  // In-memory IP-based rate limiter for verify-email (mitigates token brute-force).
  const verifyEmailIpHits = new Map<string, number[]>();
  const VERIFY_EMAIL_WINDOW_MS = 60 * 1000;
  const VERIFY_EMAIL_MAX_PER_WINDOW = 10;

  app.post("/api/marketplace/auth/verify-email", async (req, res) => {
    try {
      const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
      const now = Date.now();
      const hits = (verifyEmailIpHits.get(ip) ?? []).filter((t) => now - t < VERIFY_EMAIL_WINDOW_MS);
      if (hits.length >= VERIFY_EMAIL_MAX_PER_WINDOW) {
        return res.status(429).json({ error: "Too many verification attempts. Please try again shortly." });
      }
      hits.push(now);
      verifyEmailIpHits.set(ip, hits);

      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: "Verification token required" });
      }
      const user = await storage.getMarketplaceUserByVerificationToken(token);
      if (!user || !user.emailVerificationTokenExpiry || new Date() > user.emailVerificationTokenExpiry) {
        return res.status(400).json({ error: "Invalid or expired verification link. Please request a new one." });
      }
      await storage.updateMarketplaceUser(user.id, {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiry: null,
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[Email Verification] verify error:', error);
      res.status(500).json({ error: "Failed to verify email" });
    }
  });

  app.post("/api/marketplace/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password required" });
      }

      const user = await storage.getMarketplaceUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.passwordHash) {
        return res.status(401).json({ error: "This account uses Google sign-in. Please use 'Continue with Google'." });
      }
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      await storage.updateMarketplaceUser(user.id, { lastLoginAt: new Date() });

      const payload = { userId: user.id, email: user.email, role: "marketplace_player" };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await storage.createMarketplaceAuthSession(user.id, refreshToken, expiresAt);

      res.json({
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, phone: user.phone, linkedPlayerId: user.linkedPlayerId, photoUrl: user.photoUrl },
      });
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/marketplace/auth/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

      const decoded = verifyRefreshToken(refreshToken);
      if (!decoded) return res.status(401).json({ error: "Invalid refresh token" });

      const session = await storage.findMarketplaceAuthSession(refreshToken);
      if (!session || new Date() > session.expiresAt) {
        return res.status(401).json({ error: "Session expired" });
      }

      const user = await storage.getMarketplaceUser(session.userId);
      if (!user) return res.status(401).json({ error: "User not found" });

      const payload = { userId: user.id, email: user.email, role: "marketplace_player" };
      const newAccessToken = generateAccessToken(payload);

      res.json({ accessToken: newAccessToken });
    } catch (error) {
      res.status(500).json({ error: "Token refresh failed" });
    }
  });

  // Exchange a single-use payment-resume token for a fresh access+refresh
  // token pair. Used by CheckoutSuccess after Ziina hands the redirect to a
  // browser context that does not share localStorage with the original tab
  // (PWA → system browser, in-app browser → Safari, etc.). Generic 401 on any
  // failure so we don't leak why a token didn't work.
  app.post("/api/marketplace/auth/resume", async (req, res) => {
    const log = (outcome: 'ok' | 'expired' | 'used' | 'unknown' | 'invalid' | 'error', bookingId: string | null) => {
      console.log(JSON.stringify({ event: 'payment_resume_exchange', bookingId, outcome }));
    };
    try {
      const raw = typeof req.body?.resume === 'string' ? req.body.resume : '';
      if (!raw) {
        log('invalid', null);
        return res.status(401).json({ error: 'Invalid resume token' });
      }

      const tokenHash = createHash('sha256').update(raw).digest('hex');
      const result = await storage.consumePaymentResumeToken(tokenHash);
      if (result.status !== 'ok') {
        log(result.status, null);
        return res.status(401).json({ error: 'Invalid resume token' });
      }
      const token = result.token;

      const user = await storage.getMarketplaceUser(token.marketplaceUserId);
      if (!user) {
        log('invalid', token.bookingId);
        return res.status(401).json({ error: 'Invalid resume token' });
      }

      // Defense-in-depth: verify the booking still belongs to this user.
      const booking = await storage.getBooking(token.bookingId);
      if (!booking || booking.userId !== user.id) {
        log('invalid', token.bookingId);
        return res.status(401).json({ error: 'Invalid resume token' });
      }

      const payload = { userId: user.id, email: user.email, role: 'marketplace_player' };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await storage.createMarketplaceAuthSession(user.id, refreshToken, expiresAt);

      log('ok', token.bookingId);
      return res.json({ accessToken, refreshToken });
    } catch (error) {
      log('error', null);
      return res.status(401).json({ error: 'Invalid resume token' });
    }
  });

  app.get("/api/marketplace/auth/me", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getMarketplaceUser(req.user.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      let linkedPlayer = null;
      if (user.linkedPlayerId) {
        linkedPlayer = await storage.getPlayer(user.linkedPlayerId);
      }

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        linkedPlayerId: user.linkedPlayerId,
        linkedPlayer,
        role: user.role,
        emailVerified: user.emailVerified,
        hasPassword: !!user.passwordHash,
        photoUrl: user.photoUrl,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  app.post("/api/marketplace/auth/logout", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const { refreshToken } = req.body;
      if (refreshToken) {
        const session = await storage.findMarketplaceAuthSession(refreshToken);
        if (session) await storage.deleteMarketplaceAuthSession(session.id);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Logout failed" });
    }
  });

  // ============================================================
  // PASSWORD RESET
  // ============================================================

  app.post("/api/marketplace/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const user = await storage.getMarketplaceUserByEmail(email.toLowerCase().trim());
      if (user) {
        const token = randomUUID().replace(/-/g, '');
        const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await storage.updateMarketplaceUser(user.id, { resetToken: token, resetTokenExpiry: expiry });

        const host = req.get('host') || 'localhost:5000';
        const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
        const resetUrl = `${protocol}://${host}/marketplace/reset-password?token=${token}`;

        try {
          await sendPasswordResetEmail(user.email, resetUrl);
          console.log(`[Password Reset] Email sent to ${user.email}`);
        } catch (emailErr) {
          console.error(`[Password Reset] Email failed for ${user.email}, token: ${token}`, emailErr);
        }
      }

      // Always return the same response to prevent email enumeration
      res.json({ success: true, message: "If that email is registered, a reset link is on its way." });
    } catch (error) {
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  app.post("/api/marketplace/auth/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) return res.status(400).json({ error: "Token and password required" });
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

      // Find user by token
      const user = await storage.getMarketplaceUserByResetToken(token);
      if (!user || !user.resetTokenExpiry || new Date() > user.resetTokenExpiry) {
        return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
      }

      const passwordHash = await hashPassword(password);
      await storage.updateMarketplaceUser(user.id, {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      });

      res.json({ success: true, message: "Password updated. You can now log in." });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // ============================================================
  // PROFILE PHOTO
  // ============================================================

  const profilePhotoDir = path.resolve(process.cwd(), "uploads/profile");
  if (!fs.existsSync(profilePhotoDir)) {
    fs.mkdirSync(profilePhotoDir, { recursive: true });
  }

  const PROFILE_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const PROFILE_MAX_SIZE = 5 * 1024 * 1024;
  const PROFILE_AVATAR_SIZE = 256;
  const PROFILE_ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);

  const profilePhotoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PROFILE_MAX_SIZE },
    fileFilter: (_req, file, cb) => {
      // First-pass filter on the client-declared MIME so that obviously wrong
      // uploads (e.g. .exe with text/plain) are rejected before we read them
      // into memory. The authoritative check happens after upload via sharp.
      if (PROFILE_ALLOWED_MIME.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Only JPEG, PNG, WebP, and GIF images are allowed"));
      }
    },
  });

  function unlinkLocalPhoto(photoUrl: string | null | undefined) {
    if (!photoUrl) return;
    if (!photoUrl.startsWith("/uploads/profile/")) return;
    const filename = path.basename(photoUrl);
    const fullPath = path.join(profilePhotoDir, filename);
    fs.unlink(fullPath, () => {});
  }

  app.post(
    "/api/marketplace/profile/photo",
    requireAuth,
    requireMarketplaceAuth,
    (req: AuthRequest, res) => {
      profilePhotoUpload.single("photo")(req, res, async (err: unknown) => {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ error: "File size exceeds 5MB limit" });
          }
          return res.status(400).json({ error: err.message });
        }
        if (err instanceof Error) {
          return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ error: "No image file provided" });
        }
        try {
          if (!req.user) return res.status(401).json({ error: "Not authenticated" });

          // Authoritative content-based validation: decode the image with
          // sharp and trust ONLY its detected format. This rejects
          // disguised payloads (e.g. an HTML file with a fake image/jpeg
          // Content-Type) and lets us pick a safe server-side extension.
          // The original buffer is then resized to a small square avatar and
          // re-encoded as WebP so we never persist the (potentially large)
          // original upload.
          let resizedBuffer: Buffer;
          try {
            const pipeline = sharp(req.file.buffer, { animated: false });
            const meta = await pipeline.metadata();
            if (!meta.format || !PROFILE_ALLOWED_INPUT_FORMATS.has(meta.format)) {
              return res
                .status(400)
                .json({ error: "Only JPEG, PNG, WebP, and GIF images are allowed" });
            }
            resizedBuffer = await pipeline
              .rotate()
              .resize(PROFILE_AVATAR_SIZE, PROFILE_AVATAR_SIZE, {
                fit: "cover",
                position: "centre",
                withoutEnlargement: false,
              })
              .webp({ quality: 82 })
              .toBuffer();
          } catch {
            return res.status(400).json({ error: "Uploaded file is not a valid image" });
          }

          const filename = `${req.user.userId}-${Date.now()}-${randomUUID()}.webp`;
          const fullPath = path.join(profilePhotoDir, filename);
          await fs.promises.writeFile(fullPath, resizedBuffer);

          const existing = await storage.getMarketplaceUser(req.user.userId);
          const newUrl = `/uploads/profile/${filename}`;
          const updated = await storage.updateMarketplaceUserPhoto(req.user.userId, newUrl);
          if (!updated) {
            unlinkLocalPhoto(newUrl);
            return res.status(404).json({ error: "User not found" });
          }
          if (existing?.photoUrl && existing.photoUrl !== newUrl) {
            unlinkLocalPhoto(existing.photoUrl);
          }
          res.json({ photoUrl: newUrl });
        } catch (e) {
          console.error("[Profile Photo] upload error:", e);
          res.status(500).json({ error: "Failed to save photo" });
        }
      });
    },
  );

  app.delete(
    "/api/marketplace/profile/photo",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const existing = await storage.getMarketplaceUser(req.user.userId);
        if (!existing) return res.status(404).json({ error: "User not found" });
        await storage.updateMarketplaceUserPhoto(req.user.userId, null);
        unlinkLocalPhoto(existing.photoUrl);
        res.json({ success: true });
      } catch (e) {
        console.error("[Profile Photo] delete error:", e);
        res.status(500).json({ error: "Failed to remove photo" });
      }
    },
  );

  // ============================================================
  // GOOGLE OAUTH
  // ============================================================

  // The domain registered in Google Cloud Console for the OAuth callback.
  // Always use the *.replit.app domain so the callback URI never changes.
  function getOAuthCanonicalDomain(): string {
    const replitDomains = (process.env.REPLIT_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
    return replitDomains.find((d) => d.endsWith('.replit.app')) || replitDomains[0] || '';
  }

  // All domains this deployment serves — used to validate return domains.
  function getAllowedReturnDomains(): string[] {
    const replitDomains = (process.env.REPLIT_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
    return [...replitDomains, 'localhost:5000', 'localhost'];
  }

  function getGoogleOAuthClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const canonicalDomain = getOAuthCanonicalDomain();
    const redirectUri = canonicalDomain
      ? `https://${canonicalDomain}/api/marketplace/auth/google/callback`
      : 'http://localhost:5000/api/marketplace/auth/google/callback';
    return { client: new OAuth2Client(clientId, clientSecret, redirectUri), redirectUri };
  }

  function isSecureContext(): boolean {
    return !!process.env.REPLIT_DOMAINS || process.env.NODE_ENV === 'production';
  }

  // Strip default ports from a host string so comparisons are reliable
  // e.g. "example.com:443" → "example.com", "localhost:80" → "localhost"
  function normalizeHost(host: string): string {
    return host.replace(/:443$/, '').replace(/:80$/, '');
  }

  app.get("/api/marketplace/auth/google", (req, res) => {
    try {
      const canonicalDomain = getOAuthCanonicalDomain();
      const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
      const currentHost = normalizeHost(rawHost);

      // If the user is not on the canonical OAuth domain, redirect them there first.
      // This ensures the state CSRF cookie is always set on the same domain as the
      // Google callback URI, preventing cross-domain cookie failures.
      if (canonicalDomain && currentHost && currentHost !== canonicalDomain) {
        const allowedDomains = getAllowedReturnDomains();
        const returnDomain = allowedDomains.includes(currentHost) ? currentHost : null;
        const qs = new URLSearchParams();
        if (returnDomain) qs.set('returnDomain', returnDomain);
        const returnPath = (req.query.returnPath as string) || '';
        if (returnPath) qs.set('returnPath', returnPath);
        const promo = (req.query.promo as string) || '';
        if (promo) qs.set('promo', promo);
        return res.redirect(`https://${canonicalDomain}/api/marketplace/auth/google?${qs.toString()}`);
      }

      const { client } = getGoogleOAuthClient();
      const state = randomUUID();
      const secure = isSecureContext();
      const cookieOpts = { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' as const, secure };

      res.cookie('google_oauth_state', state, cookieOpts);

      // Persist the originating domain and return path so we can redirect
      // the user back to the right place after a successful login.
      const returnDomain = req.query.returnDomain as string | undefined;
      const returnPath = req.query.returnPath as string | undefined;

      if (returnDomain && getAllowedReturnDomains().includes(returnDomain)) {
        res.cookie('oauth_return_domain', returnDomain, cookieOpts);
      }
      if (returnPath && returnPath.startsWith('/marketplace/') && returnPath.length < 300) {
        res.cookie('oauth_return_path', returnPath, cookieOpts);
      }

      // Carry promo slug through OAuth so /welcome → Google → callback
      // still grants the AED 15 jersey signup credit.
      const promo = req.query.promo as string | undefined;
      if (promo && /^[a-z0-9_-]{1,32}$/i.test(promo)) {
        res.cookie('oauth_promo', promo, cookieOpts);
      }

      const url = client.generateAuthUrl({
        access_type: 'offline',
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
      });
      res.redirect(url);
    } catch (error) {
      console.error('Google OAuth init error:', error);
      res.redirect('/marketplace/login?error=google_failed');
    }
  });

  app.get("/api/marketplace/auth/google/callback", async (req, res) => {
    try {
      const { code, state, error: oauthError } = req.query as Record<string, string>;

      const secure = isSecureContext();
      const clearOpts = { httpOnly: true, sameSite: 'lax' as const, secure };

      if (oauthError) {
        return res.redirect('/marketplace/login?error=google_failed');
      }

      const storedState = req.cookies?.google_oauth_state;
      if (!storedState || storedState !== state) {
        console.warn('[Google OAuth] State mismatch — possible cookie domain issue or user retried mid-flow');
        return res.redirect('/marketplace/login?error=google_failed');
      }

      // Clear CSRF state cookie
      res.clearCookie('google_oauth_state', clearOpts);

      // Read and clear return-context cookies
      const returnDomain: string | undefined = req.cookies?.oauth_return_domain;
      const returnPath: string | undefined = req.cookies?.oauth_return_path;
      const promo: string | undefined = req.cookies?.oauth_promo;
      res.clearCookie('oauth_return_domain', clearOpts);
      res.clearCookie('oauth_return_path', clearOpts);
      res.clearCookie('oauth_promo', clearOpts);

      const { client } = getGoogleOAuthClient();
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);

      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token!,
        audience: process.env.GOOGLE_CLIENT_ID!,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return res.redirect('/marketplace/login?error=google_failed');
      }

      if (!payload.email_verified) {
        console.warn('[Google OAuth] Rejected unverified email:', payload.email);
        return res.redirect('/marketplace/login?error=google_email_unverified');
      }

      const { sub: googleId, email, name: googleName, picture: googlePicture } = payload;
      const displayName = googleName || email.split('@')[0];

      // Look up or create marketplace user
      let user = await storage.getMarketplaceUserByGoogleId(googleId);
      if (!user) {
        user = await storage.getMarketplaceUserByEmail(email);
        if (user) {
          // Existing email/password account — attach Google ID and treat the
          // email as verified (Google has confirmed it). Also backfill the
          // photo from Google if the user hasn't uploaded one of their own.
          const updates: Partial<typeof user> = {
            googleId,
            emailVerified: true,
            emailVerificationToken: null,
            emailVerificationTokenExpiry: null,
          };
          if (!user.photoUrl && googlePicture) {
            updates.photoUrl = googlePicture;
          }
          await storage.updateMarketplaceUser(user.id, updates);
          user = { ...user, ...updates } as typeof user;
        } else {
          // Brand new account via Google. The jersey promo slug (if any)
          // grants the same AED 15 wallet credit as the email/password
          // signup flow.
          const promoCredit = creditForPromo(promo);
          user = await storage.createMarketplaceUser({
            email,
            passwordHash: null,
            name: displayName,
            phone: null,
            linkedPlayerId: null,
            role: 'player',
            googleId,
            pendingSignupCreditFils: promoCredit,
            emailVerified: true,
            photoUrl: googlePicture ?? null,
          });
          // Fire-and-forget welcome email
          const marketplaceUrl = process.env.REPLIT_DOMAINS
            ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}/marketplace`
            : 'http://localhost:5000/marketplace';
          sendWelcomeEmail(user.email, user.name, marketplaceUrl).catch(() => {});
          // Retroactive guest linking
          storage.linkGuestsByEmail(user.email, user.id).catch(() => {});
        }
      } else {
        // Returning Google user. Backfill emailVerified (for accounts that
        // pre-date the verification feature) and the photoUrl (for accounts
        // that pre-date the photo feature). Never overwrite an existing
        // user-uploaded photo.
        const updates: Partial<typeof user> = {};
        if (!user.emailVerified) updates.emailVerified = true;
        if (!user.photoUrl && googlePicture) updates.photoUrl = googlePicture;
        if (Object.keys(updates).length > 0) {
          await storage.updateMarketplaceUser(user.id, updates);
          user = { ...user, ...updates } as typeof user;
        }
      }

      await storage.updateMarketplaceUser(user.id, { lastLoginAt: new Date() });

      const jwtPayload = { userId: user.id, email: user.email, role: 'marketplace_player' };
      const accessToken = generateAccessToken(jwtPayload);
      const refreshToken = generateRefreshToken(jwtPayload);

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await storage.createMarketplaceAuthSession(user.id, refreshToken, expiresAt);

      const params = new URLSearchParams({ accessToken, refreshToken });
      if (returnPath) params.set('returnPath', returnPath);

      // Redirect back to the originating domain if it differs from canonical
      const allowedDomains = getAllowedReturnDomains();
      if (returnDomain && allowedDomains.includes(returnDomain)) {
        const scheme = returnDomain.startsWith('localhost') ? 'http' : 'https';
        return res.redirect(`${scheme}://${returnDomain}/marketplace/auth/callback?${params.toString()}`);
      }

      res.redirect(`/marketplace/auth/callback?${params.toString()}`);
    } catch (error) {
      console.error('Google OAuth callback error:', error);
      res.redirect('/marketplace/login?error=google_failed');
    }
  });

  // ============================================================
  // PLAYER LINKING
  // ============================================================

  app.post("/api/marketplace/link-player", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { playerId } = req.body;
      if (!playerId) return res.status(400).json({ error: "Player ID required" });

      const player = await storage.getPlayer(playerId);
      if (!player) return res.status(404).json({ error: "Player not found" });

      const me = await storage.getMarketplaceUser(req.user.userId);
      if (!me) return res.status(401).json({ error: "Account not found" });

      // If this account already links to this player, treat as success (idempotent)
      if (me.linkedPlayerId === playerId) {
        return res.json({ success: true, player });
      }

      // Block re-linking a player already claimed by someone else
      const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
      if (existingOwner && existingOwner.id !== req.user.userId) {
        return res.status(409).json({
          error: "This player profile is already linked to another account. If this is you, please contact support.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }

      // Ownership proof: only a verified-email match is accepted on the
      // self-service fast path. Email/phone on an unverified account is just
      // user input — trusting it would let an attacker register with someone
      // else's known contact info and claim their player wallet.
      const normEmail = (s?: string | null) => (s ?? "").trim().toLowerCase();
      const emailsMatch =
        !!me.email &&
        !!player.email &&
        normEmail(me.email) === normEmail(player.email);

      if (emailsMatch && !me.emailVerified) {
        // Distinct path: tell the client the emails do match but our copy of
        // the email isn't verified yet, so they can verify and retry.
        return res.status(403).json({
          error:
            "Your email matches this player profile, but we need to verify your email first. Please verify your email and try again.",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      if (!emailsMatch || !me.emailVerified) {
        return res.status(403).json({
          error:
            "We couldn't verify this player profile belongs to you. Verify your email, or use the OTP flow to confirm with the contact on the player record.",
          code: "OWNERSHIP_NOT_VERIFIED",
        });
      }

      // Atomic claim: only succeeds if no other account grabbed it in a race.
      const linked = await storage.linkPlayerIfUnclaimed(req.user.userId, playerId);
      if (!linked) {
        return res.status(409).json({
          error: "This player profile was just claimed by another account. Please contact support if this is you.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }
      await applyPendingSignupCredit(req.user.userId, playerId);
      res.json({ success: true, player });
    } catch (error) {
      console.error("link-player error:", error);
      res.status(500).json({ error: "Failed to link player" });
    }
  });

  // ─── OTP-based ownership proof ──────────────────────────────────────────
  // For users whose marketplace email/phone doesn't match the player record
  // (typo, old number, no email on file). We send a one-time code to the
  // contact ON THE PLAYER record — only someone with access to that mailbox
  // can complete the link.

  const OTP_TTL_MS = 10 * 60 * 1000;       // 10 minutes
  const OTP_MAX_ATTEMPTS = 5;
  const OTP_PER_PAIR_WINDOW_MS = 10 * 60 * 1000;
  const OTP_PER_PAIR_LIMIT = 3;
  const OTP_PER_USER_WINDOW_MS = 60 * 60 * 1000;
  const OTP_PER_USER_LIMIT = 8;

  const hashOtp = (code: string) => createHash("sha256").update(code).digest("hex");
  const maskEmail = (email: string) => {
    const [local, domain] = email.split("@");
    if (!local || !domain) return email;
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
  };
  const maskPhone = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 4) return phone.replace(/.(?=.{0})/g, "*");
    const last = digits.slice(-2);
    return `${"•".repeat(Math.max(2, digits.length - 2))}${last}`;
  };

  // Lightweight preview of where the verification code WOULD be sent — no
  // OTP row is created and no email/SMS is dispatched. Lets the UI show
  // "We'll send a code to ja***@gmail.com" before the user commits, so they
  // don't waste rate-limit slots on the wrong contact.
  app.get("/api/marketplace/link-player/contact-preview", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const playerId = (req.query.playerId as string | undefined)?.trim();
      if (!playerId) return res.status(400).json({ error: "Player ID required" });

      const me = await storage.getMarketplaceUser(req.user.userId);
      if (!me) return res.status(401).json({ error: "Account not found" });
      if (me.linkedPlayerId === playerId) {
        return res.json({ alreadyLinked: true });
      }

      const player = await storage.getPlayer(playerId);
      if (!player) return res.status(404).json({ error: "Player not found" });

      const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
      if (existingOwner && existingOwner.id !== req.user.userId) {
        return res.status(409).json({
          error: "This player profile is already linked to another account. If this is you, please contact support.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }

      const playerEmail = (player.email ?? "").trim();
      const playerPhone = (player.phone ?? "").trim();
      const canEmail = !!playerEmail;
      const canSms = !!playerPhone && isSmsConfigured();

      if (!canEmail && !canSms) {
        if (playerPhone && !isSmsConfigured()) {
          return res.status(422).json({
            error: "This player profile only has a phone number, and SMS delivery isn't enabled in this environment. Please contact support to link manually.",
            code: "SMS_NOT_CONFIGURED",
          });
        }
        return res.status(422).json({
          error: "This player profile has no email or phone on file. Please contact support to link manually.",
          code: "NO_DELIVERY_CHANNEL",
        });
      }

      // Default channel mirrors the request-otp logic: prefer email when available.
      const defaultChannel: "email" | "phone" = canEmail ? "email" : "phone";
      const destination = defaultChannel === "email"
        ? maskEmail(playerEmail)
        : maskPhone(playerPhone);

      res.json({
        playerId,
        playerName: player.name,
        channel: defaultChannel,
        destination,
        availableChannels: [
          ...(canEmail ? ["email"] : []),
          ...(canSms ? ["phone"] : []),
        ],
        maskedEmail: canEmail ? maskEmail(playerEmail) : null,
        maskedPhone: canSms ? maskPhone(playerPhone) : null,
      });
    } catch (error) {
      console.error("link-player/contact-preview error:", error);
      res.status(500).json({ error: "Failed to load contact preview" });
    }
  });

  app.post("/api/marketplace/link-player/request-otp", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const schema = z.object({ playerId: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Player ID required" });
      const { playerId } = parsed.data;

      const me = await storage.getMarketplaceUser(req.user.userId);
      if (!me) return res.status(401).json({ error: "Account not found" });
      if (me.linkedPlayerId === playerId) return res.json({ success: true, alreadyLinked: true });

      const player = await storage.getPlayer(playerId);
      if (!player) return res.status(404).json({ error: "Player not found" });

      const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
      if (existingOwner && existingOwner.id !== req.user.userId) {
        return res.status(409).json({
          error: "This player profile is already linked to another account. If this is you, please contact support.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }

      // Determine which channels we can deliver to. Email always works
      // (Resend is wired); SMS only if Twilio env vars are set.
      const playerEmail = (player.email ?? "").trim();
      const playerPhone = (player.phone ?? "").trim();
      const requestedChannel = (req.body?.channel as string | undefined)?.toLowerCase();
      const canEmail = !!playerEmail;
      const canSms = !!playerPhone && isSmsConfigured();

      let channel: "email" | "phone";
      if (requestedChannel === "phone" && canSms) channel = "phone";
      else if (requestedChannel === "email" && canEmail) channel = "email";
      else if (canEmail) channel = "email";
      else if (canSms) channel = "phone";
      else if (playerPhone && !isSmsConfigured()) {
        return res.status(422).json({
          error: "This player profile only has a phone number, and SMS delivery isn't enabled in this environment. Please contact support to link manually.",
          code: "SMS_NOT_CONFIGURED",
        });
      } else {
        return res.status(422).json({
          error: "This player profile has no email or phone on file. Please contact support to link manually.",
          code: "NO_DELIVERY_CHANNEL",
        });
      }
      const destination = channel === "email" ? playerEmail : playerPhone;

      // Rate limit: per (user, player) and per user.
      const pairCount = await storage.countPlayerLinkOtpsForPairSince(
        req.user.userId, playerId, new Date(Date.now() - OTP_PER_PAIR_WINDOW_MS),
      );
      if (pairCount >= OTP_PER_PAIR_LIMIT) {
        return res.status(429).json({
          error: "Too many codes requested for this player. Please wait a few minutes and try again.",
          code: "OTP_RATE_LIMITED",
        });
      }
      const userCount = await storage.countPlayerLinkOtpsForUserSince(
        req.user.userId, new Date(Date.now() - OTP_PER_USER_WINDOW_MS),
      );
      if (userCount >= OTP_PER_USER_LIMIT) {
        return res.status(429).json({
          error: "Too many verification codes requested. Please wait an hour and try again.",
          code: "OTP_RATE_LIMITED",
        });
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await storage.createPlayerLinkOtp({
        marketplaceUserId: req.user.userId,
        playerId,
        channel,
        destination,
        codeHash: hashOtp(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      });

      try {
        if (channel === "email") {
          await sendPlayerLinkOtpEmail(destination, player.name, code);
        } else {
          await sendPlayerLinkOtpSms(destination, code);
        }
      } catch (err) {
        // Don't leak details; the OTP row will simply expire unused.
        console.error(`link-player OTP ${channel} send failed:`, err);
        return res.status(502).json({
          error: channel === "email"
            ? "Failed to send verification email. Please try again shortly."
            : "Failed to send verification SMS. Please try again shortly.",
        });
      }

      const maskedDestination = channel === "email" ? maskEmail(destination) : maskPhone(destination);
      res.json({
        success: true,
        channel,
        destination: maskedDestination,
        availableChannels: [
          ...(canEmail ? ["email"] : []),
          ...(canSms ? ["phone"] : []),
        ],
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    } catch (error) {
      console.error("link-player/request-otp error:", error);
      res.status(500).json({ error: "Failed to send code" });
    }
  });

  app.post("/api/marketplace/link-player/verify-otp", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const schema = z.object({
        playerId: z.string().min(1),
        code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      const { playerId, code } = parsed.data;

      const me = await storage.getMarketplaceUser(req.user.userId);
      if (!me) return res.status(401).json({ error: "Account not found" });
      if (me.linkedPlayerId === playerId) {
        const player = await storage.getPlayer(playerId);
        return res.json({ success: true, player });
      }

      const player = await storage.getPlayer(playerId);
      if (!player) return res.status(404).json({ error: "Player not found" });

      const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
      if (existingOwner && existingOwner.id !== req.user.userId) {
        return res.status(409).json({
          error: "This player profile is already linked to another account.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }

      const otp = await storage.getLatestActivePlayerLinkOtp(req.user.userId, playerId);
      if (!otp) {
        return res.status(400).json({
          error: "No active code. Please request a new one.",
          code: "OTP_NOT_FOUND",
        });
      }
      if (otp.attempts >= OTP_MAX_ATTEMPTS) {
        await storage.consumePlayerLinkOtp(otp.id);
        return res.status(429).json({
          error: "Too many incorrect attempts. Please request a new code.",
          code: "OTP_ATTEMPTS_EXCEEDED",
        });
      }

      if (hashOtp(code) !== otp.codeHash) {
        const updated = await storage.incrementPlayerLinkOtpAttempts(otp.id);
        const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? otp.attempts + 1));
        return res.status(400).json({
          error: remaining > 0
            ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
            : "Incorrect code. Please request a new one.",
          code: "OTP_INVALID",
          attemptsRemaining: remaining,
        });
      }

      await storage.consumePlayerLinkOtp(otp.id);

      const linked = await storage.linkPlayerIfUnclaimed(req.user.userId, playerId);
      if (!linked) {
        return res.status(409).json({
          error: "This player profile was just claimed by another account.",
          code: "PLAYER_ALREADY_LINKED",
        });
      }
      await applyPendingSignupCredit(req.user.userId, playerId);
      console.info(`[audit] link-player via OTP: marketplaceUser=${req.user.userId} playerId=${playerId}`);
      res.json({ success: true, player });
    } catch (error) {
      console.error("link-player/verify-otp error:", error);
      res.status(500).json({ error: "Failed to verify code" });
    }
  });

  // ─── Self-service player contact info update ────────────────────────────
  // For users in the link-OTP flow whose player record has a stale or wrong
  // email/phone. They can request a contact change; we send the OTP to the
  // NEW value so only someone with access to that mailbox/number can complete
  // the change. The change is recorded as an audit row (who, field, old→new,
  // when) in player_contact_change_requests. Once verified, the player record
  // is updated and the player is linked to the requesting user.
  const CONTACT_CHANGE_PER_USER_WINDOW_MS = 60 * 60 * 1000;
  const CONTACT_CHANGE_PER_USER_LIMIT = 5;

  // Lightweight phone normalization: strip everything but digits and a leading +.
  function normalizePhone(input: string): string {
    const trimmed = input.trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    return hasPlus ? `+${digits}` : digits;
  }

  app.post(
    "/api/marketplace/link-player/contact-change/request-otp",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const schema = z.object({
          playerId: z.string().min(1),
          field: z.enum(['email', 'phone']),
          newValue: z.string().min(3).max(200),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { playerId, field } = parsed.data;
        let { newValue } = parsed.data;

        // Validate value shape per field type
        if (field === 'email') {
          const emailParse = z.string().email().safeParse(newValue.trim());
          if (!emailParse.success) return res.status(400).json({ error: "Enter a valid email address" });
          newValue = emailParse.data.trim().toLowerCase();
        } else {
          newValue = normalizePhone(newValue);
          if (newValue.replace(/\D/g, '').length < 7) {
            return res.status(400).json({ error: "Enter a valid phone number" });
          }
          if (!isSmsConfigured()) {
            return res.status(422).json({
              error: "SMS delivery isn't enabled in this environment, so phone updates can't be verified right now. Try email instead or contact support.",
              code: "SMS_NOT_CONFIGURED",
            });
          }
        }

        const me = await storage.getMarketplaceUser(req.user.userId);
        if (!me) return res.status(401).json({ error: "Account not found" });

        const player = await storage.getPlayer(playerId);
        if (!player) return res.status(404).json({ error: "Player not found" });

        const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
        if (existingOwner && existingOwner.id !== req.user.userId) {
          return res.status(409).json({
            error: "This player profile is already linked to another account. If this is you, please contact support.",
            code: "PLAYER_ALREADY_LINKED",
          });
        }

        const oldValue = field === 'email' ? (player.email ?? null) : (player.phone ?? null);
        if (oldValue && oldValue.trim().toLowerCase() === newValue.toLowerCase()) {
          return res.status(400).json({ error: `That ${field} already matches the player record.` });
        }

        // Per-user rate limit on contact change requests
        const userCount = await storage.countPlayerContactChangeRequestsForUserSince(
          req.user.userId,
          new Date(Date.now() - CONTACT_CHANGE_PER_USER_WINDOW_MS),
        );
        if (userCount >= CONTACT_CHANGE_PER_USER_LIMIT) {
          return res.status(429).json({
            error: "Too many contact-change requests. Please wait an hour and try again.",
            code: "OTP_RATE_LIMITED",
          });
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        await storage.createPlayerContactChangeRequest({
          marketplaceUserId: req.user.userId,
          playerId,
          field,
          oldValue,
          newValue,
          codeHash: hashOtp(code),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        });

        try {
          if (field === 'email') {
            await sendPlayerContactChangeOtpEmail(newValue, player.name, code);
          } else {
            await sendPlayerLinkOtpSms(newValue, code);
          }
        } catch (err) {
          console.error(`contact-change OTP ${field} send failed:`, err);
          return res.status(502).json({
            error: field === 'email'
              ? "Failed to send verification email. Please try again shortly."
              : "Failed to send verification SMS. Please try again shortly.",
          });
        }

        const masked = field === 'email' ? maskEmail(newValue) : maskPhone(newValue);
        res.json({
          success: true,
          field,
          destination: masked,
          expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        });
      } catch (error) {
        console.error("contact-change/request-otp error:", error);
        res.status(500).json({ error: "Failed to send code" });
      }
    },
  );

  app.post(
    "/api/marketplace/link-player/contact-change/verify-otp",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const schema = z.object({
          playerId: z.string().min(1),
          code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { playerId, code } = parsed.data;

        const me = await storage.getMarketplaceUser(req.user.userId);
        if (!me) return res.status(401).json({ error: "Account not found" });

        const player = await storage.getPlayer(playerId);
        if (!player) return res.status(404).json({ error: "Player not found" });

        const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
        if (existingOwner && existingOwner.id !== req.user.userId) {
          return res.status(409).json({
            error: "This player profile is already linked to another account.",
            code: "PLAYER_ALREADY_LINKED",
          });
        }

        const request = await storage.getLatestActivePlayerContactChangeRequest(req.user.userId, playerId);
        if (!request) {
          return res.status(400).json({
            error: "No active contact-change request. Please request a new code.",
            code: "OTP_NOT_FOUND",
          });
        }
        if (request.attempts >= OTP_MAX_ATTEMPTS) {
          await storage.consumePlayerContactChangeRequest(request.id, 'cancelled');
          return res.status(429).json({
            error: "Too many incorrect attempts. Please request a new code.",
            code: "OTP_ATTEMPTS_EXCEEDED",
          });
        }

        if (hashOtp(code) !== request.codeHash) {
          const updated = await storage.incrementPlayerContactChangeAttempts(request.id);
          const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? request.attempts + 1));
          return res.status(400).json({
            error: remaining > 0
              ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
              : "Incorrect code. Please request a new one.",
            code: "OTP_INVALID",
            attemptsRemaining: remaining,
          });
        }

        // Apply the contact change to the player record
        if (request.field === 'email') {
          await storage.updatePlayer(playerId, { email: request.newValue });
        } else {
          await storage.updatePlayer(playerId, { phone: request.newValue });
        }
        await storage.consumePlayerContactChangeRequest(request.id, 'verified');

        // Now that ownership of the new contact is proven, link the player.
        const linked = await storage.linkPlayerIfUnclaimed(req.user.userId, playerId);
        if (!linked && me.linkedPlayerId !== playerId) {
          return res.status(409).json({
            error: "This player profile was just claimed by another account.",
            code: "PLAYER_ALREADY_LINKED",
          });
        }
        await applyPendingSignupCredit(req.user.userId, playerId);

        console.info(
          `[audit] player-contact-change: marketplaceUser=${req.user.userId} playerId=${playerId} field=${request.field} old=${request.oldValue ?? ''} new=${request.newValue} verifiedAt=${new Date().toISOString()}`,
        );

        const updatedPlayer = await storage.getPlayer(playerId);
        res.json({ success: true, player: updatedPlayer, field: request.field });
      } catch (error) {
        console.error("contact-change/verify-otp error:", error);
        res.status(500).json({ error: "Failed to verify code" });
      }
    },
  );

  // ─── Self-service marketplace account contact info update ───────────────
  // Lets a marketplace user update the email or phone on their own
  // marketplace_users record. The new value is verified via a 6-digit OTP
  // sent to the NEW value (so only someone with access to that mailbox/number
  // can complete the change). The change is recorded as an audit row in
  // marketplace_user_contact_changes (who, field, old→new, when).
  const ACCOUNT_CONTACT_CHANGE_PER_USER_WINDOW_MS = 60 * 60 * 1000;
  const ACCOUNT_CONTACT_CHANGE_PER_USER_LIMIT = 5;

  app.post(
    "/api/marketplace/account/contact-change/request-otp",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const schema = z.object({
          field: z.enum(['email', 'phone']),
          newValue: z.string().min(3).max(200),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { field } = parsed.data;
        let { newValue } = parsed.data;

        if (field === 'email') {
          const emailParse = z.string().email().safeParse(newValue.trim());
          if (!emailParse.success) return res.status(400).json({ error: "Enter a valid email address" });
          newValue = emailParse.data.trim().toLowerCase();
        } else {
          newValue = normalizePhone(newValue);
          if (newValue.replace(/\D/g, '').length < 7) {
            return res.status(400).json({ error: "Enter a valid phone number" });
          }
          if (!isSmsConfigured()) {
            return res.status(422).json({
              error: "SMS delivery isn't enabled in this environment, so phone updates can't be verified right now. Try email instead or contact support.",
              code: "SMS_NOT_CONFIGURED",
            });
          }
        }

        const me = await storage.getMarketplaceUser(req.user.userId);
        if (!me) return res.status(401).json({ error: "Account not found" });

        const oldValue = field === 'email' ? me.email : (me.phone ?? null);
        if (oldValue && oldValue.trim().toLowerCase() === newValue.toLowerCase()) {
          return res.status(400).json({ error: `That ${field} already matches your account.` });
        }

        // Email uniqueness check. (Phone is intentionally not deduped here:
        // marketplace_users.phone has no unique constraint, multiple players
        // legitimately share a number — e.g. family — and we don't key any
        // lookups off phone.)
        if (field === 'email') {
          const existing = await storage.getMarketplaceUserByEmail(newValue);
          if (existing && existing.id !== req.user.userId) {
            return res.status(409).json({
              error: "That email is already in use by another account.",
              code: "EMAIL_IN_USE",
            });
          }
        }

        const userCount = await storage.countMarketplaceUserContactChangesForUserSince(
          req.user.userId,
          new Date(Date.now() - ACCOUNT_CONTACT_CHANGE_PER_USER_WINDOW_MS),
        );
        if (userCount >= ACCOUNT_CONTACT_CHANGE_PER_USER_LIMIT) {
          return res.status(429).json({
            error: "Too many contact-change requests. Please wait an hour and try again.",
            code: "OTP_RATE_LIMITED",
          });
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        await storage.createMarketplaceUserContactChange({
          marketplaceUserId: req.user.userId,
          field,
          oldValue,
          newValue,
          codeHash: hashOtp(code),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        });

        try {
          if (field === 'email') {
            await sendMarketplaceContactChangeOtpEmail(newValue, code);
          } else {
            await sendPlayerLinkOtpSms(newValue, code);
          }
        } catch (err) {
          console.error(`account contact-change OTP ${field} send failed:`, err);
          return res.status(502).json({
            error: field === 'email'
              ? "Failed to send verification email. Please try again shortly."
              : "Failed to send verification SMS. Please try again shortly.",
          });
        }

        const masked = field === 'email' ? maskEmail(newValue) : maskPhone(newValue);
        res.json({
          success: true,
          field,
          destination: masked,
          expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        });
      } catch (error) {
        console.error("account/contact-change/request-otp error:", error);
        res.status(500).json({ error: "Failed to send code" });
      }
    },
  );

  app.post(
    "/api/marketplace/account/contact-change/verify-otp",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const schema = z.object({
          code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { code } = parsed.data;

        const me = await storage.getMarketplaceUser(req.user.userId);
        if (!me) return res.status(401).json({ error: "Account not found" });

        const request = await storage.getLatestActiveMarketplaceUserContactChange(req.user.userId);
        if (!request) {
          return res.status(400).json({
            error: "No active contact-change request. Please request a new code.",
            code: "OTP_NOT_FOUND",
          });
        }
        if (request.attempts >= OTP_MAX_ATTEMPTS) {
          await storage.consumeMarketplaceUserContactChange(request.id, 'cancelled');
          return res.status(429).json({
            error: "Too many incorrect attempts. Please request a new code.",
            code: "OTP_ATTEMPTS_EXCEEDED",
          });
        }

        if (hashOtp(code) !== request.codeHash) {
          const updated = await storage.incrementMarketplaceUserContactChangeAttempts(request.id);
          const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? request.attempts + 1));
          return res.status(400).json({
            error: remaining > 0
              ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
              : "Incorrect code. Please request a new one.",
            code: "OTP_INVALID",
            attemptsRemaining: remaining,
          });
        }

        // Re-check email uniqueness right before applying, to close the
        // tiny race where another account claimed the email after the request
        // was issued.
        if (request.field === 'email') {
          const existing = await storage.getMarketplaceUserByEmail(request.newValue);
          if (existing && existing.id !== req.user.userId) {
            await storage.consumeMarketplaceUserContactChange(request.id, 'cancelled');
            return res.status(409).json({
              error: "That email is already in use by another account.",
              code: "EMAIL_IN_USE",
            });
          }
        }

        if (request.field === 'email') {
          await storage.updateMarketplaceUser(req.user.userId, { email: request.newValue });
        } else {
          await storage.updateMarketplaceUser(req.user.userId, { phone: request.newValue });
        }
        await storage.consumeMarketplaceUserContactChange(request.id, 'verified');

        console.info(
          `[audit] marketplace-account-contact-change: marketplaceUser=${req.user.userId} field=${request.field} old=${request.oldValue ?? ''} new=${request.newValue} verifiedAt=${new Date().toISOString()}`,
        );

        const updated = await storage.getMarketplaceUser(req.user.userId);
        res.json({
          success: true,
          field: request.field,
          email: updated?.email,
          phone: updated?.phone,
        });
      } catch (error) {
        console.error("account/contact-change/verify-otp error:", error);
        res.status(500).json({ error: "Failed to verify code" });
      }
    },
  );

  app.get("/api/marketplace/search-players", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const query = req.query.q as string;
      if (!query || query.length < 2) return res.json([]);
      const results = await storage.searchPlayers(query);
      res.json(results.slice(0, 10).map((p: any) => ({
        id: p.id,
        name: p.name,
        shuttleIqId: p.shuttleIqId,
        level: p.level,
        skillScore: p.skillScore,
      })));
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  // Unified guest search: marketplace users + SIQ players, deduped
  app.get("/api/marketplace/search-guests", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const query = req.query.q as string;
      if (!query || query.length < 2) return res.json([]);

      // Search marketplace users and SIQ players in parallel
      const [mpUsers, siqPlayers] = await Promise.all([
        storage.searchMarketplaceUsersByName(query),
        storage.searchPlayers(query),
      ]);

      type GuestResult = {
        type: 'marketplace' | 'siq';
        name: string;
        email?: string;
        level?: string | null;
        marketplaceUserId?: string;
        siqPlayerId?: string;
      };

      const results: GuestResult[] = [];
      const usedSiqIds = new Set<string>();

      // Marketplace users first (preferred — email is known)
      for (const u of mpUsers) {
        results.push({
          type: 'marketplace',
          name: u.name,
          email: u.email,
          marketplaceUserId: u.id,
          siqPlayerId: u.linkedPlayerId ?? undefined,
          level: undefined, // resolved below if linked
        });
        if (u.linkedPlayerId) usedSiqIds.add(u.linkedPlayerId);
      }

      // Add level info for marketplace users that are linked to SIQ players.
      // Use name-matched search results first; fall back to direct ID lookup when names differ.
      const missingLevelUserIds = results
        .filter(r => r.siqPlayerId && !siqPlayers.find(p => p.id === r.siqPlayerId))
        .map(r => r.siqPlayerId as string);

      const directPlayerLookups = await Promise.all(
        missingLevelUserIds.map(id => storage.getPlayer(id).catch(() => null))
      );
      const directPlayerMap = new Map(
        directPlayerLookups.filter(Boolean).map((p: any) => [p.id, p])
      );

      for (const r of results) {
        if (r.siqPlayerId) {
          const linked = siqPlayers.find(p => p.id === r.siqPlayerId) ?? directPlayerMap.get(r.siqPlayerId);
          if (linked) r.level = linked.level;
        }
      }

      // SIQ-only players (not already covered by a linked marketplace user)
      for (const p of siqPlayers) {
        if (!usedSiqIds.has(p.id)) {
          results.push({
            type: 'siq',
            name: p.name,
            level: p.level,
            siqPlayerId: p.id,
          });
        }
      }

      res.json(results.slice(0, 10));
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.get("/api/marketplace/admin/search-players", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const query = req.query.q as string;
      if (!query || query.length < 2) return res.json([]);
      const results = await storage.searchPlayersWithContact(query);
      res.json(results.slice(0, 10));
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  // Admin link player
  app.post("/api/marketplace/admin/link-player", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { marketplaceUserId, playerId, force } = req.body;
      if (!marketplaceUserId || !playerId) return res.status(400).json({ error: "Both user ID and player ID required" });

      const user = await storage.getMarketplaceUser(marketplaceUserId);
      if (!user) return res.status(404).json({ error: "Marketplace user not found" });

      const player = await storage.getPlayer(playerId);
      if (!player) return res.status(404).json({ error: "Player not found" });

      // Guard against silently stealing a player from another account
      const existingOwner = await storage.getMarketplaceUserByLinkedPlayerId(playerId);
      if (existingOwner && existingOwner.id !== marketplaceUserId && !force) {
        return res.status(409).json({
          error: `This player is already linked to ${existingOwner.email}. Pass force=true to reassign.`,
          code: "PLAYER_ALREADY_LINKED",
          existingOwner: { id: existingOwner.id, email: existingOwner.email, name: existingOwner.name },
        });
      }

      if (existingOwner && existingOwner.id !== marketplaceUserId && force) {
        console.warn(
          `[audit] admin/link-player reassignment by adminId=${req.user?.userId}: player ${playerId} moved from marketplaceUser ${existingOwner.id} (${existingOwner.email}) to ${marketplaceUserId} (${user.email})`
        );
        await storage.updateMarketplaceUser(existingOwner.id, { linkedPlayerId: null });
      } else {
        console.info(
          `[audit] admin/link-player by adminId=${req.user?.userId}: linked player ${playerId} to marketplaceUser ${marketplaceUserId} (${user.email})`
        );
      }

      await storage.updateMarketplaceUser(marketplaceUserId, { linkedPlayerId: playerId });
      await applyPendingSignupCredit(marketplaceUserId, playerId);
      res.json({ success: true });
    } catch (error) {
      console.error("admin/link-player error:", error);
      res.status(500).json({ error: "Failed to link player" });
    }
  });

  // Admin endpoint — returns ALL bookable sessions including past ones (for admin management)
  app.get("/api/marketplace/admin/sessions", requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
    try {
      const sessions = await storage.getAllBookableSessions();
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // ============================================================
  // BOOKABLE SESSIONS
  // ============================================================

  app.get("/api/marketplace/sessions", async (_req, res) => {
    try {
      const sessions = await storage.getUpcomingBookableSessions();
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  app.get("/api/marketplace/sessions/:id", async (req, res) => {
    try {
      const session = await storage.getBookableSessionWithAvailability(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.patch("/api/marketplace/sessions/:id", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const updates = req.body;
      if (updates.date) updates.date = new Date(updates.date);
      const session = await storage.updateBookableSession(req.params.id, updates);
      if (!session) return res.status(404).json({ error: "Session not found" });
      res.json(session);
    } catch (error) {
      console.error('Failed to update marketplace session:', error);
      res.status(500).json({ error: "Failed to update session" });
    }
  });

  app.patch("/api/marketplace/sessions/:id/link", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { sessionId } = req.body;
      if (sessionId !== null && sessionId !== undefined) {
        const adminSession = await storage.getSession(sessionId);
        if (!adminSession) return res.status(404).json({ error: "Admin session not found" });
        if (adminSession.status !== 'active' && adminSession.status !== 'upcoming') {
          return res.status(400).json({ error: "Can only link to active or upcoming sessions" });
        }
      }
      const updated = await storage.updateBookableSession(req.params.id, {
        linkedSessionId: sessionId || null,
      });
      if (!updated) return res.status(404).json({ error: "Bookable session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to link session" });
    }
  });

  app.delete("/api/marketplace/sessions/:id", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const deleted = await storage.deleteBookableSession(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Session not found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  // ============================================================
  // CHECKOUT
  // ============================================================

  app.post("/api/marketplace/bookings", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { sessionId, paymentMethod, guests: guestList, applyWallet } = req.body;
      if (!sessionId) return res.status(400).json({ error: "Session ID required" });

      // Validate guest list (optional array of { name, email?, marketplaceUserId?, siqPlayerId? })
      const guestSchema = z.array(z.object({
        name: z.string().min(1).max(100),
        email: z.string().email().optional().nullable(),
        marketplaceUserId: z.string().optional().nullable(),
        siqPlayerId: z.string().optional().nullable(),
      })).max(3).optional();
      const parsedGuests = guestSchema.safeParse(guestList);
      if (!parsedGuests.success) return res.status(400).json({ error: "Invalid guest list" });
      const guests = parsedGuests.data ?? [];
      const spotsBooked = 1 + guests.length; // booker + guests

      const method = paymentMethod === 'cash' ? 'cash' : 'ziina';

      const existingBooking = await storage.getUserBookingForSession(req.user.userId, sessionId);
      if (existingBooking) {
        if (existingBooking.status === 'pending') {
          // Check if the Ziina payment already completed before cancelling — avoids a race
          // where the user retries while the first payment is still being processed
          if (existingBooking.ziinaPaymentIntentId) {
            try {
              const ziinaStatus = await retrieveZiinaPaymentIntent(existingBooking.ziinaPaymentIntentId);
              if (isZiinaPaymentSuccessful(ziinaStatus.status)) {
                return res.status(400).json({ error: "Your payment is being processed. Please wait a moment and refresh." });
              }
            } catch (_) {
              // Ziina check failed — proceed with cancellation so user can retry
            }
          }
          // Payment not completed — cancel the stale pending booking and allow retry
          await refundBookingWalletCredit(existingBooking);
          await storage.updateBooking(existingBooking.id, { status: 'cancelled', cancelledAt: new Date(), walletAmountUsed: 0 });
        } else if (existingBooking.status !== 'cancelled') {
          return res.status(400).json({ error: "You already have a booking for this session" });
        }
      }

      const bookableSession = await storage.getBookableSessionWithAvailability(sessionId);
      if (!bookableSession) return res.status(404).json({ error: "Session not found" });
      if (bookableSession.status === "cancelled") return res.status(400).json({ error: "Session is cancelled" });

      const baseUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
        : 'http://localhost:5000';

      // Fetch primary user once — needed for waitlist path too
      const primaryUser = await storage.getMarketplaceUser(req.user.userId);

      // Helper: create per-slot booking_guest rows for ALL spots (primary + extras),
      // making the per-slot model explicit. Primary booker gets isPrimary=true.
      const createAllSlotsForBooking = async (
        bookingId: string,
        slotStatus: 'confirmed' | 'pending' = 'confirmed',
        sendGuestEmails = true,
      ) => {
        // Primary booker slot (no cancellation token — they manage via booking cancel)
        await storage.createBookingGuest({
          bookingId,
          name: primaryUser?.name ?? 'Booker',
          email: primaryUser?.email ?? null,
          linkedUserId: req.user!.userId,
          isPrimary: true,
          status: slotStatus,
          cancellationToken: null,
        });

        // Additional guest slots
        for (const g of guests) {
          const token = randomUUID();
          let linkedUserId: string | null = null;
          let resolvedEmail: string | null = g.email ?? null;

          // Resolve marketplace user by provided ID first — authoritative email wins
          if (g.marketplaceUserId) {
            const mpUser = await storage.getMarketplaceUser(g.marketplaceUserId);
            if (mpUser) {
              linkedUserId = mpUser.id;
              resolvedEmail = mpUser.email || resolvedEmail;
            }
          }

          // Fallback: resolve by email if no marketplace user ID given
          if (!linkedUserId && resolvedEmail) {
            const existingUser = await storage.getMarketplaceUserByEmail(resolvedEmail);
            if (existingUser) linkedUserId = existingUser.id;
          }

          // Fallback: resolve by SIQ player -> linked marketplace user
          if (!linkedUserId && g.siqPlayerId) {
            const mpUserViaSiq = await storage.getMarketplaceUserByLinkedPlayerId(g.siqPlayerId);
            if (mpUserViaSiq) {
              linkedUserId = mpUserViaSiq.id;
              resolvedEmail = mpUserViaSiq.email || resolvedEmail;
            }
          }

          await storage.createBookingGuest({
            bookingId,
            name: g.name,
            email: resolvedEmail,
            linkedUserId,
            isPrimary: false,
            status: slotStatus,
            cancellationToken: token,
          });
          if (sendGuestEmails && slotStatus === 'confirmed' && resolvedEmail && primaryUser) {
            const cancelGuestUrl = `${baseUrl}/marketplace/guests/cancel/${token}`;
            const signupUrl = `${baseUrl}/marketplace/signup?email=${encodeURIComponent(resolvedEmail)}`;
            sendGuestBookingEmail(resolvedEmail, g.name, primaryUser.name, bookableSession, cancelGuestUrl, signupUrl).catch(() => {});
          }
        }
      };

      // Handle waitlist when session is full (or would exceed capacity with all spots)
      if (bookableSession.spotsRemaining < spotsBooked) {
        const waitlistCount = await storage.getWaitlistCountForSession(sessionId);
        const booking = await storage.createBooking({
          userId: req.user.userId,
          sessionId,
          status: 'waitlisted',
          paymentMethod: method, // preserve user's chosen payment method for promotion logic
          ziinaPaymentIntentId: null,
          amountAed: bookableSession.priceAed * spotsBooked,
          cashPaid: false,
          waitlistPosition: waitlistCount + 1,
          lateFeeApplied: false,
          spotsBooked,
        });
        // Persist all slot rows even for waitlisted bookings so guest metadata/tokens survive promotion
        await createAllSlotsForBooking(booking.id, 'pending', false);
        return res.json({
          bookingId: booking.id,
          waitlisted: true,
          waitlistPosition: booking.waitlistPosition,
          amount: bookableSession.priceAed * spotsBooked,
          session: {
            title: bookableSession.title,
            venueName: bookableSession.venueName,
            date: bookableSession.date,
            startTime: bookableSession.startTime,
            endTime: bookableSession.endTime,
          },
        });
      }

      if (method === 'cash') {
        const totalAmount = bookableSession.priceAed * spotsBooked;
        const booking = await storage.createBooking({
          userId: req.user.userId,
          sessionId,
          status: "confirmed",
          paymentMethod: "cash",
          ziinaPaymentIntentId: null,
          amountAed: totalAmount,
          cashPaid: false,
          spotsBooked,
        });

        // Create all slot rows (primary + guests) in booking_guests
        await createAllSlotsForBooking(booking.id, 'confirmed', true);

        // Notify linked guests (non-primary) of their confirmed spot
        const cashGuests = await storage.getBookingGuests(booking.id);
        for (const g of cashGuests) {
          if (!g.isPrimary && g.linkedUserId) {
            await storage.createMarketplaceNotification({
              userId: g.linkedUserId,
              type: 'guest_booking_confirmed',
              title: 'You have a booking!',
              message: `${primaryUser?.name ?? 'Someone'} added you as a guest for "${bookableSession.title}" on ${new Date(bookableSession.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${bookableSession.venueName}.`,
              relatedBookingId: booking.id,
            });
          }
        }

        // Fire-and-forget booking confirmation email (fully isolated)
        try {
          if (primaryUser) {
            sendBookingConfirmationEmail(primaryUser.email, primaryUser.name, bookableSession, 'cash', totalAmount).catch(() => {});
          }
        } catch (emailErr) { console.error('[Email] cash booking confirm lookup failed:', emailErr); }

        const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
        return res.json({
          bookingId: booking.id,
          paymentMethod: "cash",
          amount: totalAmount,
          spotsBooked,
          booking: bookingWithDetails,
          session: {
            title: bookableSession.title,
            venueName: bookableSession.venueName,
            date: bookableSession.date,
            startTime: bookableSession.startTime,
            endTime: bookableSession.endTime,
          },
        });
      }

      const totalAmount = bookableSession.priceAed * spotsBooked;
      const totalAmountFils = totalAmount * 100;

      // Create booking first (pending for Ziina, confirmed for full wallet coverage)
      const booking = await storage.createBooking({
        userId: req.user.userId,
        sessionId,
        status: "pending",
        paymentMethod: "ziina",
        ziinaPaymentIntentId: null,
        amountAed: totalAmount,
        cashPaid: false,
        spotsBooked,
      });

      // Apply wallet credit if requested (uses shared deductWalletForBooking helper)
      let walletApplied = 0;
      let remainingFils = totalAmountFils;
      if (applyWallet) {
        const walletResult = await deductWalletForBooking(req.user.userId, booking.id, totalAmountFils);
        walletApplied = walletResult.walletApplied;
        remainingFils = walletResult.remainingFils;
      }

      // If wallet fully covers the cost, confirm booking without Ziina
      if (walletApplied > 0 && remainingFils <= 0) {
        await storage.updateBooking(booking.id, { status: 'confirmed', paymentMethod: 'wallet' });
        await createAllSlotsForBooking(booking.id, 'confirmed', true);

        try {
          if (primaryUser) {
            sendBookingConfirmationEmail(primaryUser.email, primaryUser.name, bookableSession, 'wallet', totalAmount).catch(() => {});
          }
        } catch (emailErr) { console.error('[Email] wallet booking confirm failed:', emailErr); }

        const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
        return res.json({
          bookingId: booking.id,
          paymentMethod: "wallet",
          amount: totalAmount,
          walletApplied,
          spotsBooked,
          booking: bookingWithDetails,
          session: {
            title: bookableSession.title,
            venueName: bookableSession.venueName,
            date: bookableSession.date,
            startTime: bookableSession.startTime,
            endTime: bookableSession.endTime,
          },
        });
      }

      // Ziina path: charge the remaining amount (after wallet deduction, if any)
      const ziinaAmountAed = walletApplied > 0 ? Math.round(remainingFils / 100) : totalAmount;

      let paymentIntent;
      try {
        const resumeParam = await mintPaymentResumeParam(req.user!.userId, booking.id);
        paymentIntent = await createZiinaPaymentIntent({
          amountAed: ziinaAmountAed,
          message: buildZiinaBookingMessage({ title: bookableSession.title, spots: spotsBooked }),
          successUrl: `${baseUrl}/marketplace/checkout/success?booking_id=${booking.id}${resumeParam}`,
          cancelUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}`,
          failureUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}&failed=1`,
        });
      } catch (intentError: unknown) {
        // Refund wallet if Ziina fails
        if (walletApplied > 0) {
          const failedBooking = await storage.getBooking(booking.id);
          if (failedBooking) await refundBookingWalletCredit(failedBooking);
        }
        await storage.updateBooking(booking.id, { status: 'cancelled', cancelledAt: new Date(), walletAmountUsed: 0 });
        const rawErr = intentError instanceof Error ? intentError.message : String(intentError);
        console.error('[Ziina] Payment intent creation failed — booking cancelled', {
          bookingId: booking.id,
          sessionId: booking.sessionId,
          amountAed: ziinaAmountAed,
          error: rawErr,
          rawError: intentError,
        });
        return res.status(502).json({ error: "We couldn't start your card payment — please try again, or choose Pay at Venue." });
      }

      await storage.updateBooking(booking.id, { ziinaPaymentIntentId: paymentIntent.id });

      // Store all slot rows as pending — emails sent only upon Ziina payment confirmation
      await createAllSlotsForBooking(booking.id, 'pending', false);

      res.json({
        bookingId: booking.id,
        paymentMethod: "ziina",
        paymentIntentId: paymentIntent.id,
        redirectUrl: paymentIntent.redirect_url,
        amount: totalAmount,
        walletApplied,
        ziinaAmount: ziinaAmountAed,
        spotsBooked,
        session: {
          title: bookableSession.title,
          venueName: bookableSession.venueName,
          date: bookableSession.date,
          startTime: bookableSession.startTime,
          endTime: bookableSession.endTime,
        },
      });
    } catch (error: unknown) {
      const pgErr = error as Record<string, unknown>;
      if (pgErr?.code === '23505' && pgErr?.constraint === 'unique_active_booking_per_session') {
        return res.status(400).json({ error: "You already have a booking for this session" });
      }
      console.error('Booking error:', error);
      const msg = error instanceof Error ? error.message : "Failed to create booking";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/marketplace/bookings/:id/confirm", async (req: AuthRequest, res) => {
    try {
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      if (booking.status === 'confirmed') {
        const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
        return res.json({ confirmed: true, booking: bookingWithDetails });
      }

      if (!booking.ziinaPaymentIntentId) {
        return res.status(400).json({ error: "No payment associated with this booking" });
      }

      // Re-fetch the latest payment status from Ziina before confirming.
      const paymentIntent = await retrieveZiinaPaymentIntent(booking.ziinaPaymentIntentId);

      if (isZiinaPaymentSuccessful(paymentIntent.status)) {
        // Delegate to the shared confirmation logic (also used by the webhook handler).
        const result = await confirmZiinaBookingByIntentId(booking.ziinaPaymentIntentId, paymentIntent.status);

        if (result.waitlisted) {
          const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
          return res.json({ confirmed: false, waitlisted: true, booking: bookingWithDetails, status: 'session_full' });
        }

        const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
        return res.json({ confirmed: true, booking: bookingWithDetails });
      } else {
        console.warn('[Ziina] Payment not successful for booking', {
          bookingId: booking.id,
          intentId: booking.ziinaPaymentIntentId,
          status: paymentIntent.status,
        });
        return res.json({ confirmed: false, status: paymentIntent.status });
      }
    } catch (error: unknown) {
      console.error('[Ziina] Confirm error for booking', {
        bookingId: req.params.id,
        error: error instanceof Error ? error.message : error,
        rawError: error,
      });
      res.status(500).json({ error: "Failed to confirm booking" });
    }
  });

  // Authenticated: initiate Ziina payment for a pending_payment (waitlist-promoted) booking
  app.post("/api/marketplace/bookings/:id/initiate-payment", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.userId !== req.user.userId) return res.status(403).json({ error: "Not authorized" });
      if (booking.status !== 'pending_payment') {
        return res.status(400).json({ error: "Booking is not awaiting payment" });
      }
      if (booking.paymentMethod !== 'ziina') {
        return res.status(400).json({ error: "This booking does not require online payment" });
      }
      if (!booking.promotedAt) {
        return res.status(400).json({ error: "Booking has no payment window set" });
      }
      const paymentDeadline = new Date(booking.promotedAt).getTime() + 4 * 60 * 60 * 1000;
      if (Date.now() > paymentDeadline) {
        return res.status(410).json({ error: "Payment window has expired. Your spot has been released." });
      }

      const bookableSession = await storage.getBookableSession(booking.sessionId);
      if (!bookableSession) return res.status(404).json({ error: "Session not found" });

      const baseUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
        : 'http://localhost:5000';

      let paymentIntent;
      try {
        const resumeParam = await mintPaymentResumeParam(req.user.userId, booking.id);
        paymentIntent = await createZiinaPaymentIntent({
          amountAed: booking.amountAed,
          message: buildZiinaBookingMessage({ title: bookableSession.title, spots: booking.spotsBooked ?? 1 }),
          successUrl: `${baseUrl}/marketplace/checkout/success?booking_id=${booking.id}${resumeParam}`,
          cancelUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}`,
          failureUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}&failed=1`,
        });
      } catch (intentError: unknown) {
        const rawErr = intentError instanceof Error ? intentError.message : String(intentError);
        console.error('[Ziina] Intent creation failed for pending_payment booking', {
          bookingId: booking.id,
          sessionId: booking.sessionId,
          amountAed: booking.amountAed,
          error: rawErr,
          rawError: intentError,
        });
        return res.status(502).json({ error: "We couldn't start your card payment — please try again, or choose Pay at Venue." });
      }

      await storage.updateBooking(booking.id, { ziinaPaymentIntentId: paymentIntent.id });
      return res.json({ redirectUrl: paymentIntent.redirect_url });
    } catch (error: unknown) {
      console.error('[Ziina] initiate-payment error for booking', {
        bookingId: req.params.id,
        error: error instanceof Error ? error.message : error,
        rawError: error,
      });
      res.status(500).json({ error: "Failed to initiate payment" });
    }
  });

  // Public: guest self-cancel via unique token (no auth required)
  app.post("/api/marketplace/guests/cancel", async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: "Cancellation token required" });

      const guest = await storage.getBookingGuestByToken(token);
      if (!guest) return res.status(404).json({ error: "Invalid cancellation link" });
      if (guest.status === 'cancelled') return res.json({ alreadyCancelled: true });

      const booking = await storage.getBooking(guest.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status === 'cancelled') return res.status(400).json({ error: "Parent booking is already cancelled" });

      // Cancel the guest
      await storage.updateBookingGuest(guest.id, { status: 'cancelled', cancelledAt: new Date() });

      // Flag Ziina booking for admin refund review
      if (booking.paymentMethod === 'ziina' && booking.ziinaPaymentIntentId) {
        const proratedAmount = booking.amountAed / (booking.spotsBooked ?? 1);
        await storage.createMarketplaceNotification({
          userId: booking.userId,
          type: 'refund_required',
          title: 'Partial refund required',
          message: `Guest slot cancelled on Ziina booking. A prorated refund of approximately AED ${proratedAmount.toFixed(2)} may be owed. Please process via Ziina dashboard.`,
          relatedBookingId: booking.id,
        });
      }

      // Decrement spotsBooked on the parent booking
      const newSpots = Math.max(1, (booking.spotsBooked ?? 1) - 1);
      await storage.updateBooking(booking.id, { spotsBooked: newSpots });

      res.json({ cancelled: true, guestName: guest.name });
    } catch (error: any) {
      console.error('Guest cancel error:', error);
      res.status(500).json({ error: "Failed to cancel guest spot" });
    }
  });

  // Public: lookup guest by token (for the self-cancel page) — query-string form
  app.get("/api/marketplace/guests/by-token", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.status(400).json({ error: "Token required" });
      const guest = await storage.getBookingGuestByToken(token);
      if (!guest) return res.status(404).json({ error: "Invalid token" });
      const booking = await storage.getBooking(guest.bookingId);
      const session = booking ? await storage.getBookableSession(booking.sessionId) : null;
      res.json({ guest, session });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch guest info" });
    }
  });

  // Public: lookup guest by token — path-param form
  app.get("/api/marketplace/guests/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const guest = await storage.getBookingGuestByToken(token);
      if (!guest) return res.status(404).json({ error: "Invalid token" });
      const booking = await storage.getBooking(guest.bookingId);
      const session = booking ? await storage.getBookableSession(booking.sessionId) : null;
      res.json({ guest, session });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch guest info" });
    }
  });

  // Public: guest self-cancel by token — path-param form
  app.post("/api/marketplace/guests/:token/cancel", async (req, res) => {
    try {
      const { token } = req.params;
      const guest = await storage.getBookingGuestByToken(token);
      if (!guest) return res.status(404).json({ error: "Invalid cancellation link" });
      if (guest.status === 'cancelled') return res.json({ alreadyCancelled: true });
      const booking = await storage.getBooking(guest.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status === 'cancelled') return res.status(400).json({ error: "Parent booking is already cancelled" });
      await storage.updateBookingGuest(guest.id, { status: 'cancelled', cancelledAt: new Date() });
      // Flag Ziina booking for admin refund review
      if (booking.paymentMethod === 'ziina' && booking.ziinaPaymentIntentId) {
        const proratedAmount = booking.amountAed / (booking.spotsBooked ?? 1);
        await storage.createMarketplaceNotification({
          userId: booking.userId,
          type: 'refund_required',
          title: 'Partial refund required',
          message: `Guest slot cancelled on Ziina booking. A prorated refund of approximately AED ${proratedAmount.toFixed(2)} may be owed. Please process via Ziina dashboard.`,
          relatedBookingId: booking.id,
        });
      }
      const newSpots = Math.max(1, (booking.spotsBooked ?? 1) - 1);
      await storage.updateBooking(booking.id, { spotsBooked: newSpots });
      res.json({ cancelled: true, guestName: guest.name });
    } catch (error) {
      console.error('Guest cancel error:', error);
      res.status(500).json({ error: "Failed to cancel guest spot" });
    }
  });

  // Authenticated: delete (cancel) a specific guest slot
  // Allowed for: primary booker (booking.userId) OR linked guest (guest.linkedUserId)
  app.delete("/api/marketplace/bookings/:bookingId/guests/:guestId", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const booking = await storage.getBooking(req.params.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status === 'cancelled') return res.status(400).json({ error: "Booking is already cancelled" });

      const guests = await storage.getBookingGuests(req.params.bookingId);
      const guest = guests.find(g => g.id === req.params.guestId);
      if (!guest) return res.status(404).json({ error: "Guest not found" });
      if (guest.status === 'cancelled') return res.status(400).json({ error: "Guest slot already cancelled" });

      // Authorization: primary booker OR the linked guest themselves
      const isPrimaryBooker = booking.userId === req.user.userId;
      const isLinkedGuest = guest.linkedUserId === req.user.userId;
      if (!isPrimaryBooker && !isLinkedGuest) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await storage.updateBookingGuest(guest.id, { status: 'cancelled', cancelledAt: new Date() });

      // If primary booker cancelled this slot, notify the linked guest
      if (isPrimaryBooker && isLinkedGuest === false && guest.linkedUserId) {
        const bookableSession = await storage.getBookableSession(booking.sessionId);
        await storage.createMarketplaceNotification({
          userId: guest.linkedUserId,
          type: 'guest_slot_cancelled',
          title: 'Your spot has been cancelled',
          message: bookableSession
            ? `Your guest spot for "${bookableSession.title}" on ${new Date(bookableSession.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} has been cancelled by the booking organiser.`
            : 'Your guest spot has been cancelled by the booking organiser.',
          relatedBookingId: booking.id,
        });
      }

      // For Ziina bookings: flag the cancellation for admin review (prorated refund not supported via API)
      let refundFlaggedForAdmin = false;
      if (booking.paymentMethod === 'ziina' && booking.ziinaPaymentIntentId) {
        const proratedAmount = booking.amountAed / (booking.spotsBooked ?? 1);
        // Ziina does not have a refund API; create an admin notification for manual processing
        await storage.createMarketplaceNotification({
          userId: booking.userId,
          type: 'refund_required',
          title: 'Partial refund required',
          message: `Guest slot cancelled on Ziina booking. A prorated refund of approximately AED ${proratedAmount.toFixed(2)} may be owed. Please process via Ziina dashboard.`,
          relatedBookingId: booking.id,
        });
        refundFlaggedForAdmin = true;
      }

      // Decrement spots; if this was the last remaining spot, cancel the parent booking
      const newSpots = (booking.spotsBooked ?? 1) - 1;
      if (newSpots <= 0) {
        // Cancel parent booking (primary booker's spot is being removed)
        await storage.updateBooking(booking.id, { status: 'cancelled', cancelledAt: new Date(), spotsBooked: 0 });
        res.json({ cancelled: true, guestId: guest.id, newSpotsBooked: 0, bookingCancelled: true, refundFlaggedForAdmin });
      } else {
        await storage.updateBooking(booking.id, { spotsBooked: newSpots });
        res.json({ cancelled: true, guestId: guest.id, newSpotsBooked: newSpots, refundFlaggedForAdmin });
      }
    } catch (error) {
      console.error('Delete guest error:', error);
      res.status(500).json({ error: "Failed to cancel guest slot" });
    }
  });

  // Authenticated: reassign a guest slot (primary booker only) — update name/email + re-resolve linkedUserId
  app.patch("/api/marketplace/bookings/:bookingId/guests/:guestId", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const booking = await storage.getBooking(req.params.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.userId !== req.user.userId) return res.status(403).json({ error: "Not authorized — only primary booker can edit guest details" });
      if (booking.status === 'cancelled') return res.status(400).json({ error: "Booking is cancelled" });

      const guests = await storage.getBookingGuests(req.params.bookingId);
      const guest = guests.find(g => g.id === req.params.guestId);
      if (!guest) return res.status(404).json({ error: "Guest not found" });
      if (guest.status === 'cancelled') return res.status(400).json({ error: "Cannot edit a cancelled guest slot" });

      const { name, email } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: "Guest name is required" });
      }

      // Re-resolve linked account if email changed
      let linkedUserId = guest.linkedUserId;
      if (email !== undefined && email !== guest.email) {
        if (email) {
          const existingUser = await storage.getMarketplaceUserByEmail(email.trim());
          linkedUserId = existingUser ? existingUser.id : null;
        } else {
          linkedUserId = null;
        }
      }

      const updated = await storage.updateBookingGuest(guest.id, {
        name: name.trim(),
        email: email !== undefined ? (email?.trim() || null) : guest.email,
        linkedUserId,
      });

      res.json(updated);
    } catch (error) {
      console.error('Patch guest error:', error);
      res.status(500).json({ error: "Failed to update guest details" });
    }
  });

  // Authenticated: get guests for a specific booking (owner only)
  app.get("/api/marketplace/bookings/:id/guests", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.userId !== req.user.userId) return res.status(403).json({ error: "Not authorized" });
      const guests = await storage.getBookingGuests(req.params.id);
      res.json(guests);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch guests" });
    }
  });

  // Add an extra guest to an existing confirmed booking (cash or Ziina)
  app.post("/api/marketplace/bookings/:bookingId/add-guest", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const booking = await storage.getBooking(req.params.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.userId !== req.user.userId) return res.status(403).json({ error: "Not authorized" });
      if (booking.status !== 'confirmed') return res.status(400).json({ error: "You can only add guests to confirmed bookings" });

      const bodySchema = z.object({
        guestName: z.string().min(1).max(100),
        guestEmail: z.string().email().nullable().optional(),
        paymentMethod: z.enum(['cash', 'ziina']),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      const { guestName, guestEmail, paymentMethod } = parsed.data;

      const bookableSession = await storage.getBookableSessionWithAvailability(booking.sessionId);
      if (!bookableSession) return res.status(404).json({ error: "Session not found" });
      if (bookableSession.spotsRemaining < 1) return res.status(400).json({ error: "This session is full — no spots available" });

      const baseUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
        : 'http://localhost:5000';

      // Resolve linked marketplace user by email if possible
      let linkedUserId: string | null = null;
      if (guestEmail) {
        const existingUser = await storage.getMarketplaceUserByEmail(guestEmail);
        if (existingUser) linkedUserId = existingUser.id;
      }

      const cancellationToken = randomUUID();

      if (paymentMethod === 'cash') {
        await storage.createBookingGuest({
          bookingId: booking.id,
          name: guestName,
          email: guestEmail ?? null,
          linkedUserId,
          isPrimary: false,
          status: 'confirmed',
          cancellationToken,
        });
        await storage.updateBooking(booking.id, {
          spotsBooked: (booking.spotsBooked ?? 1) + 1,
          amountAed: booking.amountAed + bookableSession.priceAed,
        });

        if (guestEmail) {
          const primaryUser = await storage.getMarketplaceUser(req.user.userId);
          if (primaryUser) {
            const cancelGuestUrl = `${baseUrl}/marketplace/guests/cancel/${cancellationToken}`;
            const signupUrl = `${baseUrl}/marketplace/signup?email=${encodeURIComponent(guestEmail)}`;
            sendGuestBookingEmail(guestEmail, guestName, primaryUser.name, bookableSession, cancelGuestUrl, signupUrl).catch(() => {});
          }
        }

        return res.json({ success: true });
      }

      // Ziina path — create pending guest, then payment intent
      const pendingGuest = await storage.createBookingGuest({
        bookingId: booking.id,
        name: guestName,
        email: guestEmail ?? null,
        linkedUserId,
        isPrimary: false,
        status: 'pending',
        cancellationToken,
      });

      let paymentIntent;
      try {
        const resumeParam = await mintPaymentResumeParam(req.user!.userId, booking.id);
        paymentIntent = await createZiinaPaymentIntent({
          amountAed: bookableSession.priceAed,
          message: buildZiinaBookingMessage({ title: bookableSession.title, extraSpot: true }),
          successUrl: `${baseUrl}/marketplace/checkout/success?booking_id=${booking.id}&extra_guest=1${resumeParam}`,
          cancelUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}`,
          failureUrl: `${baseUrl}/marketplace/checkout/cancel?booking_id=${booking.id}&failed=1`,
        });
      } catch (intentError) {
        // Clean up the pending guest row on Ziina failure — delete it so it leaves no trace
        await storage.deleteBookingGuest(pendingGuest.id);
        const rawErr = intentError instanceof Error ? intentError.message : String(intentError);
        console.error('[Ziina] Intent creation failed for extra-guest add', {
          bookingId: booking.id,
          sessionId: booking.sessionId,
          error: rawErr,
          rawError: intentError,
        });
        return res.status(502).json({ error: "We couldn't start your card payment — please try again, or choose Pay at Venue." });
      }

      await storage.updateBookingGuest(pendingGuest.id, { pendingPaymentIntentId: paymentIntent.id });
      return res.json({ redirectUrl: paymentIntent.redirect_url });
    } catch (error) {
      console.error('add-guest error:', error);
      res.status(500).json({ error: "Failed to add guest" });
    }
  });

  // ============================================================
  // BOOKINGS
  // ============================================================

  app.post("/api/marketplace/admin/bookings", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { sessionId, userId } = req.body;
      if (!sessionId || !userId) return res.status(400).json({ error: "Session ID and user ID required" });

      const existingBooking = await storage.getUserBookingForSession(userId, sessionId);
      if (existingBooking && existingBooking.status !== 'cancelled') {
        return res.status(400).json({ error: "User already has a booking for this session" });
      }

      const session = await storage.getBookableSessionWithAvailability(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.spotsRemaining <= 0) return res.status(400).json({ error: "Session is full" });

      const booking = await storage.createBooking({
        userId,
        sessionId,
        status: "confirmed",
        paymentMethod: "cash",
        ziinaPaymentIntentId: null,
        amountAed: session.priceAed,
        cashPaid: false,
      });

      const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
      res.json(bookingWithDetails);
    } catch (error) {
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  app.get("/api/marketplace/bookings/mine", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const primaryBookings = await storage.getUserBookings(req.user.userId);
      const guestBookings = await storage.getGuestBookingsForUser(req.user.userId);
      // Merge, deduplicating by booking id (primary takes precedence)
      const seen = new Set(primaryBookings.map(b => b.id));
      const merged = [...primaryBookings, ...guestBookings.filter(b => !seen.has(b.id))];
      // Sort by createdAt desc
      merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(merged);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  app.post("/api/marketplace/bookings/:id/cancel", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.userId !== req.user.userId) return res.status(403).json({ error: "Not authorized" });
      if (booking.status === "cancelled") return res.status(400).json({ error: "Already cancelled" });

      // Check late cancellation window (< 5 hours before session start)
      let lateFeeApplied = false;
      const bookableSession = await storage.getBookableSession(booking.sessionId);
      if (bookableSession && booking.status === 'confirmed') {
        const [hours, minutes] = bookableSession.startTime.split(':').map(Number);
        const sessionStartAt = new Date(bookableSession.date);
        sessionStartAt.setHours(hours, minutes, 0, 0);
        const cutoff = new Date(sessionStartAt.getTime() - 5 * 60 * 60 * 1000);
        if (new Date() >= cutoff) {
          lateFeeApplied = true;
        }
      }

      const wasConfirmed = booking.status === 'confirmed' || booking.status === 'pending_payment';

      // Refund wallet credit if any was used (unless late fee retains full payment)
      if (!lateFeeApplied) {
        await refundBookingWalletCredit(booking);
      }

      // Cancel the booking
      const updated = await storage.updateBooking(req.params.id, {
        status: "cancelled",
        cancelledAt: new Date(),
        lateFeeApplied,
      });

      // Notify user if late fee applied
      if (lateFeeApplied && bookableSession) {
        await storage.createMarketplaceNotification({
          userId: booking.userId,
          type: 'late_fee_applied',
          title: 'Cancellation fee applied',
          message: `You cancelled "${bookableSession.title}" within 5 hours of the session start. Your full payment of AED ${booking.amountAed} has been retained.`,
          relatedBookingId: booking.id,
        });
      }

      // Send cancellation email (fully isolated so email failure cannot affect API response)
      try {
        const cancellingUser = await storage.getMarketplaceUser(booking.userId);
        if (cancellingUser && bookableSession) {
          sendCancellationEmail(cancellingUser.email, cancellingUser.name, bookableSession, lateFeeApplied, booking.amountAed).catch(() => {});
        }
      } catch (emailErr) { console.error('[Email] cancellation lookup failed:', emailErr); }

      // If was a confirmed booking, promote first waitlisted user that fits remaining capacity
      let promoted: { bookingId: string; userId: string } | null = null;
      if (wasConfirmed && bookableSession) {
        const waitlisted = await storage.getWaitlistedBookingsForSession(booking.sessionId);
        if (waitlisted.length > 0) {
          // Get current available capacity after this cancellation
          const currentCount = await storage.getBookingCountForSession(booking.sessionId);
          const spotsAvailable = bookableSession.capacity - currentCount;
          // Find first waitlisted booking that fits the available spots
          const first = waitlisted.find(w => (w.spotsBooked ?? 1) <= spotsAvailable);
          if (first) {
            const isZiinaPromotion = first.paymentMethod === 'ziina';
            const promotionBaseUrl = process.env.REPLIT_DOMAINS
              ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
              : 'http://localhost:5000';

            if (isZiinaPromotion) {
              // Ziina payment: hold the spot as pending_payment with a 4-hour window
              await storage.updateBooking(first.id, {
                status: 'pending_payment',
                waitlistPosition: null,
                promotedAt: new Date(),
              });
            } else {
              // Cash payment: immediately confirm the spot
              await storage.updateBooking(first.id, { status: 'confirmed', waitlistPosition: null });

              // Confirm all pending slot rows for the promoted booking
              const promotedSlots = await storage.getBookingGuests(first.id);
              for (const slot of promotedSlots) {
                if (slot.status === 'pending') {
                  await storage.updateBookingGuest(slot.id, { status: 'confirmed' });
                }
              }
            }

            promoted = { bookingId: first.id, userId: first.userId };

            // Create notification for promoted user
            const dateLabel = new Date(bookableSession.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
            await storage.createMarketplaceNotification({
              userId: first.userId,
              type: 'waitlist_promoted',
              title: isZiinaPromotion ? 'Spot available — complete payment!' : "You're confirmed!",
              message: isZiinaPromotion
                ? `A spot opened up for "${bookableSession.title}" on ${dateLabel} at ${bookableSession.venueName}. You have 4 hours to complete payment to secure your spot.`
                : `A spot opened up — you've been confirmed for "${bookableSession.title}" on ${dateLabel} at ${bookableSession.venueName}.`,
              relatedBookingId: first.id,
            });

            // Send waitlist promotion email + notify/email non-primary guest slots (fully isolated)
            try {
              const promotedUser = await storage.getMarketplaceUser(first.userId);
              if (promotedUser) {
                const checkoutUrl = isZiinaPromotion
                  ? `${promotionBaseUrl}/marketplace/my-bookings`
                  : undefined;
                sendWaitlistPromotionEmail(promotedUser.email, promotedUser.name, bookableSession, checkoutUrl).catch(() => {});

                if (!isZiinaPromotion) {
                  // Send emails + in-app notifications to non-primary guest slots (cash only — ziina waits for payment)
                  const confirmedSlots = await storage.getBookingGuests(first.id);
                  for (const slot of confirmedSlots) {
                    if (!slot.isPrimary && slot.status === 'confirmed') {
                      if (slot.email && slot.cancellationToken) {
                        const cancelGuestUrl = `${promotionBaseUrl}/marketplace/guests/cancel/${slot.cancellationToken}`;
                        const signupUrl = `${promotionBaseUrl}/marketplace/signup?email=${encodeURIComponent(slot.email)}`;
                        sendGuestBookingEmail(slot.email, slot.name, promotedUser.name, bookableSession, cancelGuestUrl, signupUrl).catch(() => {});
                      }
                      if (slot.linkedUserId) {
                        await storage.createMarketplaceNotification({
                          userId: slot.linkedUserId,
                          type: 'guest_booking_confirmed',
                          title: 'You have a booking!',
                          message: `${promotedUser.name} has been confirmed for "${bookableSession.title}" on ${dateLabel} — your guest spot is also confirmed.`,
                          relatedBookingId: first.id,
                        });
                      }
                    }
                  }
                }
              }
            } catch (emailErr) { console.error('[Email] waitlist promotion lookup failed:', emailErr); }

            // Re-number remaining waitlisted bookings (exclude the promoted one)
            const remaining = waitlisted.filter(w => w.id !== first.id);
            for (let i = 0; i < remaining.length; i++) {
              await storage.updateBooking(remaining[i].id, { waitlistPosition: i + 1 });
            }
          }
        }
      }

      // If a waitlisted booking was cancelled, renumber the remaining waitlisted positions
      if (booking.status === 'waitlisted') {
        const waitlisted = await storage.getWaitlistedBookingsForSession(booking.sessionId);
        for (let i = 0; i < waitlisted.length; i++) {
          await storage.updateBooking(waitlisted[i].id, { waitlistPosition: i + 1 });
        }
      }

      res.json({ booking: updated, lateFeeApplied, promoted });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel booking" });
    }
  });

  app.post("/api/marketplace/bookings/:id/attend", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status === "cancelled") return res.status(400).json({ error: "Booking is cancelled" });

      const updated = await storage.updateBooking(req.params.id, {
        status: "attended",
        attendedAt: new Date(),
      });

      let queueResult: { added: boolean; reason?: string } = { added: false };

      const marketplaceUser = await storage.getMarketplaceUser(booking.userId);
      const bookableSession = await storage.getBookableSession(booking.sessionId);

      if (!marketplaceUser?.linkedPlayerId) {
        queueResult = { added: false, reason: "no_player_link" };
      } else if (!bookableSession?.linkedSessionId) {
        queueResult = { added: false, reason: "no_session_link" };
      } else {
        const queue = await storage.getQueue(bookableSession.linkedSessionId);
        if (queue.includes(marketplaceUser.linkedPlayerId)) {
          queueResult = { added: false, reason: "already_in_queue" };
        } else {
          await storage.addToQueue(bookableSession.linkedSessionId, marketplaceUser.linkedPlayerId);
          queueResult = { added: true };
        }
      }

      // Eager matchmaking on every queue-join — mirrors the player-driven
      // self check-in path. Fires whether or not we actually appended
      // (an idempotent admin re-tap shouldn't fire it twice in a row,
      // but the orchestrator is a no-op when there's nothing to do, so
      // we keep the trigger simple). Critically, the queued-orchestrator
      // pass inside tryAutoMatchmaking now ALWAYS runs even when the
      // pending pass would skip on "no available courts" — that's how
      // a player who just joined while every court is busy still gets a
      // queued (or mixed-pool queued) lineup built for them eagerly.
      if (queueResult.added && bookableSession?.linkedSessionId) {
        const linkedSessionId = bookableSession.linkedSessionId;
        setImmediate(() => {
          tryAutoMatchmaking(linkedSessionId).catch(err => {
            console.error('[auto-matchmaking] post-admin-attend unhandled:', err);
          });
        });
      }

      res.json({ ...updated, queueResult });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark attendance" });
    }
  });

  // Self-serve check-in by the booked player. Marks the booking attended
  // and idempotently appends the player to that session's queue. The whole
  // flip happens in a single tx; the referral-completion hook fires only
  // after the tx commits.
  app.post(
    "/api/marketplace/sessions/:bookableSessionId/checkin",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const { bookableSessionId } = req.params;
        const userId = req.user!.userId;

        const bookableSession = await storage.getBookableSession(bookableSessionId);
        if (!bookableSession) {
          return res.status(404).json({ error: "Session not found." });
        }

        const booking = await storage.getUserBookingForSession(userId, bookableSessionId);
        // 404 covers both "no booking" and "booking exists but not in a
        // checkin-eligible state" (waitlisted, pending payment, cancelled).
        // The spec wording is "no confirmed booking → 404".
        if (!booking || (booking.status !== 'confirmed' && booking.status !== 'attended')) {
          return res.status(404).json({
            error: "We couldn't find a confirmed booking of yours for this session.",
          });
        }

        if (!bookableSession.linkedSessionId) {
          return res.status(400).json({
            error:
              "Session is not yet active. Please ask the Court Captain to open the session.",
          });
        }

        const user = await storage.getMarketplaceUser(userId);
        const linkedPlayerId = user?.linkedPlayerId ?? null;

        let result;
        try {
          result = await storage.checkInBookingTransaction({
            bookingId: booking.id,
            linkedSessionId: bookableSession.linkedSessionId,
            playerId: linkedPlayerId,
          });
        } catch (err: any) {
          if (err?.message === 'BOOKING_NOT_FOUND' || err?.message === 'BOOKING_NOT_ELIGIBLE') {
            return res.status(404).json({
              error: "We couldn't find a confirmed booking of yours for this session.",
            });
          }
          throw err;
        }

        // Fire-and-forget referral completion hook — only on the first
        // attended booking, mirrors the admin check-in path.
        if (!result.alreadyAttended) {
          (async () => {
            try {
              if (!user?.linkedPlayerId) return;
              const allBookings = await storage.getUserBookings(userId);
              const attendedCount = allBookings.filter(b => b.attendedAt && !b.isGuestBooking).length;
              if (attendedCount > 1) return;

              let referral = await storage.getReferralByRefereePlayerId(user.linkedPlayerId);
              if (!referral) {
                referral = await storage.getReferralByRefereeUserId(userId);
              }
              if (!referral || referral.status !== 'pending') return;

              const completed = await completeReferral(referral.id);
              if (completed.success) {
                console.log(`[Referral] Completed referral ${referral.id}: ${user.name} (self check-in)`);
              }
            } catch (err) {
              console.error('[Referral] self check-in completion hook error:', err);
            }
          })();
        }

        const message = linkedPlayerId
          ? "You're checked in."
          : "Checked in — please ask the Court Captain to add you to the queue.";

        res.json({
          success: true,
          sessionId: bookableSessionId,
          queuePosition: result.queuePosition,
          alreadyAttended: result.alreadyAttended,
          message,
          booking: result.booking,
        });

        // Fire-and-forget auto-matchmaking. Only meaningful when the user has
        // a linked player profile (otherwise they're not in the queue and
        // can't be assigned to a court). All errors are swallowed inside the
        // orchestrator — the player must never see a check-in failure caused
        // by the matchmaker.
        if (linkedPlayerId && bookableSession.linkedSessionId) {
          const linkedSessionId = bookableSession.linkedSessionId;
          setImmediate(() => {
            tryAutoMatchmaking(linkedSessionId).catch(err => {
              console.error('[auto-matchmaking] post-checkin unhandled:', err);
            });
          });
        }
      } catch (error) {
        console.error('[Self check-in] error:', error);
        res.status(500).json({ error: "Failed to check in." });
      }
    },
  );

  // Returns the currently-active admin session id, if any. The frontend uses
  // this to identify which of the player's bookings is "today's" by matching
  // bookableSession.linkedSessionId === activeSessionId.
  // (Note: path intentionally does not live under /sessions to avoid the
  // existing /api/marketplace/sessions/:id catch-all registered earlier.)
  app.get(
    "/api/marketplace/active-session",
    requireAuth,
    requireMarketplaceAuth,
    async (_req: AuthRequest, res) => {
      try {
        const session = await storage.getActiveSession();
        res.json({ activeSessionId: session?.id ?? null });
      } catch (error) {
        console.error('[Active session lookup] error:', error);
        res.status(500).json({ error: "Failed to load active session." });
      }
    },
  );

  // Returns the player's current match suggestion, pre-joined with court
  // name and the 4 players' display names + team. The /marketplace/play
  // waiting screen polls this every 5s; PlayingScreen and ScoreEntry read
  // it once on mount.
  //
  // Priority is explicit: pending|approved (next game) first, then playing
  // (live game). The score-entry screen opts in to a third tier
  // (just-finished, scoped to currently-active sessions only) by passing
  // ?for=score-entry — this is gated so the waiting/playing screens never
  // see a 'completed' row and rendering never accidentally regresses to
  // showing a stale finished match as "your next game".
  app.get(
    "/api/marketplace/players/me/current-suggestion",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const userId = req.user!.userId;
        const user = await storage.getMarketplaceUser(userId);
        const linkedPlayerId = user?.linkedPlayerId ?? null;
        if (!linkedPlayerId) {
          // Stable shape — see projection branch further down.
          return res.json({ suggestion: null, projection: null });
        }

        // Opt-in surface for the P8 score-entry screen. Other consumers
        // (waiting screen, playing screen) MUST NOT pass this, so they
        // never receive a 'completed' status — that would cause them to
        // render a stale finished match as "your next game".
        const includeCompleted = req.query.for === 'score-entry';

        // Composition with explicit priority — see the route header above.
        // The storage helper handles pending|approved (the most common
        // case). When that returns nothing, fall through to a 'playing'
        // lookup, then (only when explicitly requested) to a 'completed'
        // lookup further bounded to active sessions. Each fallback is a
        // narrow single-status query so the ordering can never collapse
        // them into a stale-vs-live mistake.
        const helperResult = await storage.getCurrentSuggestionForPlayer(linkedPlayerId);

        let parent: {
          id: string;
          courtId: string;
          // Nullable because 'queued' rows have no auto-approve deadline.
          // For pending/approved/playing/dismissed/completed rows the
          // value is always populated.
          pendingUntil: Date | null;
          status: string;
          includesActivePlayers: boolean;
        } | null = null;
        let playerRows: Array<{ playerId: string; team: number }> = [];

        if (helperResult) {
          parent = {
            id: helperResult.id,
            courtId: helperResult.courtId,
            pendingUntil: helperResult.pendingUntil,
            status: helperResult.status,
            includesActivePlayers: helperResult.includesActivePlayers,
          };
          playerRows = helperResult.players.map(p => ({
            playerId: p.playerId,
            team: p.team,
          }));
        } else {
          // Fallback 1: live 'playing' suggestion the player belongs to.
          // Drives the P5 → P7 transition. Scoped to currently-active
          // sessions so a never-resolved 'playing' row from an ended
          // session can never follow a player into a new session.
          const [playingParent] = await db
            .select({
              id: matchSuggestions.id,
              courtId: matchSuggestions.courtId,
              pendingUntil: matchSuggestions.pendingUntil,
              status: matchSuggestions.status,
              includesActivePlayers: matchSuggestions.includesActivePlayers,
            })
            .from(matchSuggestionPlayers)
            .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
            .innerJoin(sessions, eq(matchSuggestions.sessionId, sessions.id))
            .where(and(
              eq(matchSuggestionPlayers.playerId, linkedPlayerId),
              eq(matchSuggestions.status, 'playing'),
              eq(sessions.status, 'active'),
            ))
            .orderBy(desc(matchSuggestions.suggestedAt))
            .limit(1);

          if (playingParent) {
            parent = playingParent;
            playerRows = await db
              .select({
                playerId: matchSuggestionPlayers.playerId,
                team: matchSuggestionPlayers.team,
              })
              .from(matchSuggestionPlayers)
              .where(eq(matchSuggestionPlayers.suggestionId, playingParent.id));
          } else if (includeCompleted) {
            // Fallback 2 (score-entry only): most-recent 'completed'
            // suggestion bounded to currently-active sessions. Surfaces
            // the just-finished game to the P8 score-entry screen.
            //
            // The score-entry path INTENTIONALLY skips the recently-
            // dismissed fallback below — score entry only cares about
            // completed games, and a dismissed row from a separate
            // cancelled assignment must not block the player from
            // entering scores for a game they actually just finished.
            const [completedParent] = await db
              .select({
                id: matchSuggestions.id,
                courtId: matchSuggestions.courtId,
                pendingUntil: matchSuggestions.pendingUntil,
                status: matchSuggestions.status,
                includesActivePlayers: matchSuggestions.includesActivePlayers,
              })
              .from(matchSuggestionPlayers)
              .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
              .innerJoin(sessions, eq(matchSuggestions.sessionId, sessions.id))
              .where(and(
                eq(matchSuggestionPlayers.playerId, linkedPlayerId),
                eq(matchSuggestions.status, 'completed'),
                eq(sessions.status, 'active'),
              ))
              .orderBy(desc(matchSuggestions.suggestedAt))
              .limit(1);

            if (completedParent) {
              parent = completedParent;
              playerRows = await db
                .select({
                  playerId: matchSuggestionPlayers.playerId,
                  team: matchSuggestionPlayers.team,
                })
                .from(matchSuggestionPlayers)
                .where(eq(matchSuggestionPlayers.suggestionId, completedParent.id));
            }
          } else {
            // Fallback 1b (waiting/playing screens only): a recently-
            // dismissed suggestion this player belonged to. Surfaced so
            // PlayingScreen can detect an admin cancel-game (which
            // dismisses the live 'playing' row) and route the player
            // back to the waiting screen instead of falling through to
            // the score-entry screen.
            //
            // We use pendingUntil > now() as the recency check rather
            // than suggestedAt > (now - 10min). The admin write paths
            // (cancel-game, replaceActiveSuggestionForAdminAssignment)
            // bump pendingUntil to (now + 10min) when they dismiss, so
            // this filter correctly handles long-running games that
            // were assigned more than 10 minutes ago. Sweep-dismissed
            // pending rows have pendingUntil in the past and are
            // therefore excluded.
            const [dismissedParent] = await db
              .select({
                id: matchSuggestions.id,
                courtId: matchSuggestions.courtId,
                pendingUntil: matchSuggestions.pendingUntil,
                status: matchSuggestions.status,
                includesActivePlayers: matchSuggestions.includesActivePlayers,
              })
              .from(matchSuggestionPlayers)
              .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
              .innerJoin(sessions, eq(matchSuggestions.sessionId, sessions.id))
              .where(and(
                eq(matchSuggestionPlayers.playerId, linkedPlayerId),
                eq(matchSuggestions.status, 'dismissed'),
                gt(matchSuggestions.pendingUntil, new Date()),
                eq(sessions.status, 'active'),
              ))
              .orderBy(desc(matchSuggestions.suggestedAt))
              .limit(1);

            if (dismissedParent) {
              parent = dismissedParent;
              playerRows = await db
                .select({
                  playerId: matchSuggestionPlayers.playerId,
                  team: matchSuggestionPlayers.team,
                })
                .from(matchSuggestionPlayers)
                .where(eq(matchSuggestionPlayers.suggestionId, dismissedParent.id));
            }
          }
        }

        if (!parent) {
          // Projection fallback — when the player has no live suggestion
          // (queued lineup hasn't been built yet, or there genuinely
          // aren't enough players to mix into one), surface a small
          // read-only projection so the WaitingScreen can show
          // "You're #N — likely up on Court X" instead of the bare
          // "Finding your next game…" spinner. READ-ONLY: this branch
          // never writes to match_suggestions.
          let projection: {
            queuePosition: number;
            projectedCourtId: string;
            projectedCourtName: string;
          } | null = null;
          try {
            const activeSession = await storage.getActiveSession();
            if (activeSession) {
              const queue = await storage.getQueue(activeSession.id);
              const idx = queue.indexOf(linkedPlayerId);
              if (idx >= 0) {
                const allCourts = await storage.getCourtsBySession(activeSession.id);
                // Match the today-stats endpoint, which treats 'occupied'
                // as the in-play state. Pick the court whose game started
                // longest ago (i.e., the one most likely to free up first).
                const playingCourts = allCourts
                  .filter(c => c.status === 'occupied' || c.status === 'playing')
                  .sort((a, b) => {
                    const at = a.startedAt ? a.startedAt.getTime() : Number.MAX_SAFE_INTEGER;
                    const bt = b.startedAt ? b.startedAt.getTime() : Number.MAX_SAFE_INTEGER;
                    return at - bt;
                  });
                if (playingCourts.length > 0) {
                  const projCourt = playingCourts[0];
                  projection = {
                    queuePosition: idx + 1,
                    projectedCourtId: projCourt.id,
                    projectedCourtName: projCourt.name,
                  };
                }
              }
            }
          } catch (projErr) {
            console.error('[current-suggestion] projection lookup failed:', projErr);
          }
          return res.json({ suggestion: null, projection });
        }

        // Batched joins: court name (and startedAt for the playing-screen
        // server-anchored timer) + the 4 player display names.
        const [court] = await db
          .select({ id: courts.id, name: courts.name, startedAt: courts.startedAt })
          .from(courts)
          .where(eq(courts.id, parent.courtId))
          .limit(1);

        const playerIds = playerRows.map(p => p.playerId);
        const playerRecords = playerIds.length
          ? await storage.getPlayersByIds(playerIds)
          : [];
        const nameById = new Map(playerRecords.map(p => [p.id, p.name]));
        const tierById = new Map(playerRecords.map(p => [p.id, tierDisplayName(p.level)]));

        // Per-player photo URLs come from marketplaceUsers.photoUrl, joined
        // via linkedPlayerId. Players without a linked marketplace account
        // (admin-imported only) simply get null and the frontend renders
        // initials in the fallback avatar.
        let photoById = new Map<string, string | null>();
        if (playerIds.length > 0) {
          try {
            const users = await storage.getMarketplaceUsersByLinkedPlayerIds(playerIds);
            photoById = new Map(
              users
                .filter(u => u.linkedPlayerId)
                .map(u => [u.linkedPlayerId as string, u.photoUrl ?? null]),
            );
          } catch (puErr) {
            console.error('[current-suggestion] photo lookup failed:', puErr);
          }
        }

        // Identify which team the requesting player is on so the frontend can
        // render "Your team" vs "Opponents" from the player's perspective.
        const selfRow = playerRows.find(p => p.playerId === linkedPlayerId);
        const selfTeam: 1 | 2 | null =
          selfRow?.team === 1 ? 1 : selfRow?.team === 2 ? 2 : null;

        res.json({
          suggestion: {
            id: parent.id,
            status: parent.status,
            courtId: parent.courtId,
            courtName: court?.name ?? '',
            startedAt: court?.startedAt ? court.startedAt.toISOString() : null,
            pendingUntil: parent.pendingUntil,
            // Drives the muted "Lineup may adjust before the game starts"
            // note on the player's On-Deck card. true only for queued
            // rows built by Case 2/3 of the orchestrator, where the
            // lineup currently names players still on the active court
            // and may need to dismiss-and-rebuild if any of them tap
            // "I'm done" before the current game ends.
            includesActivePlayers: parent.includesActivePlayers,
            selfTeam,
            players: playerRows.map(p => ({
              playerId: p.playerId,
              playerName: nameById.get(p.playerId) ?? 'Player',
              team: p.team,
              photoUrl: photoById.get(p.playerId) ?? null,
              tierName: tierById.get(p.playerId) ?? '',
            })),
          },
        });
      } catch (error) {
        console.error('[Current suggestion] error:', error);
        res.status(500).json({ error: "Failed to load current suggestion." });
      }
    },
  );

  // POST /api/marketplace/players/me/done — "I'm done for today"
  // Removes the player from the active session's queue, dismisses any
  // queued|pending|approved suggestion that names them, and fires
  // tryAutoMatchmaking so the remaining waiting players can be reassigned
  // immediately. Idempotent — calling it twice in a row succeeds both
  // times. Returns { success: true } either way.
  app.post(
    "/api/marketplace/players/me/done",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const userId = req.user!.userId;
        const user = await storage.getMarketplaceUser(userId);
        const linkedPlayerId = user?.linkedPlayerId ?? null;
        if (!linkedPlayerId) {
          // No linked player → nothing in any session queue to remove.
          // The frontend treats this the same as a successful no-op so
          // the navigation back to /marketplace still happens.
          return res.json({ success: true });
        }

        const activeSession = await storage.getActiveSession();
        if (!activeSession) {
          return res.json({ success: true });
        }

        // 1. Remove from queue (no-op if not in it).
        await storage.removeFromQueue(activeSession.id, linkedPlayerId);

        // 2. Dismiss any non-terminal suggestion this player is named on
        //    (pending|approved|queued). 'playing' is intentionally NOT
        //    dismissed — once the live game is in motion, ending it is
        //    the Court Captain's call, not a tap-out.
        //
        // Race-safe CAS: we update by id AND status so a row that flips
        // from 'pending'→'playing' between the SELECT and the UPDATE
        // will be skipped (zero rows affected) instead of being clobbered
        // to 'dismissed'. The court state for pending/approved rows is
        // re-derived by the subsequent tryAutoMatchmaking call; queued
        // rows leave their parent court 'playing' untouched.
        const myOpenRows = await db
          .select({ id: matchSuggestions.id, status: matchSuggestions.status, courtId: matchSuggestions.courtId })
          .from(matchSuggestions)
          .innerJoin(matchSuggestionPlayers, eq(matchSuggestions.id, matchSuggestionPlayers.suggestionId))
          .where(and(
            eq(matchSuggestions.sessionId, activeSession.id),
            eq(matchSuggestionPlayers.playerId, linkedPlayerId),
            inArray(matchSuggestions.status, ['pending', 'approved', 'queued']),
          ));

        for (const row of myOpenRows) {
          await db
            .update(matchSuggestions)
            .set({ status: 'dismissed' })
            .where(and(
              eq(matchSuggestions.id, row.id),
              inArray(matchSuggestions.status, ['pending', 'approved', 'queued']),
            ));
        }

        // 3. Defensive legacy-status reset. The player should be
        //    'waiting' after tap-out — but past code paths or a stale
        //    crash mid-flow could leave players.status='playing' set
        //    even though no live 'playing' suggestion exists for them.
        //    Single atomic UPDATE: WHERE status != 'playing' AND there
        //    is NO 'playing' suggestion naming this player. Avoids the
        //    check-then-act race where startApprovedSuggestion could
        //    flip a 4th lineup mate to 'playing' between a separate
        //    SELECT and UPDATE — the entire predicate is evaluated
        //    in one statement against the current row state. If they
        //    ARE on a live court, the EXISTS clause short-circuits
        //    (zero rows updated), preserving the 'playing' flag.
        try {
          await db
            .update(players)
            .set({ status: 'waiting' })
            .where(and(
              eq(players.id, linkedPlayerId),
              eq(players.status, 'playing'),
              sql`NOT EXISTS (
                SELECT 1 FROM ${matchSuggestions} ms
                INNER JOIN ${matchSuggestionPlayers} msp ON ms.id = msp.suggestion_id
                WHERE ms.session_id = ${activeSession.id}
                  AND msp.player_id = ${linkedPlayerId}
                  AND ms.status = 'playing'
              )`,
            ));
        } catch (statusErr) {
          console.error('[me/done] defensive status reset failed:', statusErr);
        }

        // 4. Fire-and-forget rematchmaking so the remaining waiting
        //    players get reassigned to any newly free pending slot.
        setImmediate(() => {
          tryAutoMatchmaking(activeSession.id).catch(err => {
            console.error('[auto-matchmaking] post-done unhandled:', err);
          });
        });

        return res.json({ success: true });
      } catch (error) {
        console.error('[POST /api/marketplace/players/me/done] error:', error);
        return res.status(500).json({ error: "Couldn't sign you out — please ask the Court Captain for help." });
      }
    },
  );

  // GET /api/marketplace/players/me/today-stats
  // Lightweight stat counters for the WaitingScreen header chips:
  //   gamesPlayed — count of game_participants rows for this player in the
  //                 currently-active session
  //   wins        — same set, restricted to rows where team === winningTeam
  //   skillScore  — current player.skillScore (live, after each game)
  //   tierName    — display name of the player's confirmed level
  // Returns zeros / empty strings when there is no active session or the
  // player isn't linked.
  app.get(
    "/api/marketplace/players/me/today-stats",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const userId = req.user!.userId;
        const user = await storage.getMarketplaceUser(userId);
        const linkedPlayerId = user?.linkedPlayerId ?? null;

        // Resolve the player profile FIRST so skillScore + tierName are
        // always returned with real values when the account is linked,
        // regardless of whether there's an active session right now.
        const player = linkedPlayerId ? await storage.getPlayer(linkedPlayerId) : undefined;
        const skillScore = player?.skillScore ?? 0;
        const tierName = player ? tierDisplayName(player.level) : '';

        // Stable response shape: every code path returns the same keys
        // (queuePosition, courtsInPlay, lastGame) so the client can read
        // them defensively without optional-chaining each field.
        if (!linkedPlayerId) {
          return res.json({
            gamesPlayed: 0,
            wins: 0,
            skillScore,
            tierName,
            queuePosition: null,
            courtsInPlay: [],
            lastGame: null,
          });
        }

        const activeSession = await storage.getActiveSession();
        if (!activeSession) {
          return res.json({
            gamesPlayed: 0,
            wins: 0,
            skillScore,
            tierName,
            queuePosition: null,
            courtsInPlay: [],
            lastGame: null,
          });
        }

        const gpRows = await db
          .select({
            team: gameParticipants.team,
            winningTeam: gameResults.winningTeam,
          })
          .from(gameParticipants)
          .innerJoin(gameResults, eq(gameParticipants.gameId, gameResults.id))
          .where(and(
            eq(gameParticipants.playerId, linkedPlayerId),
            eq(gameResults.sessionId, activeSession.id),
          ));

        const gamesPlayed = gpRows.length;
        const wins = gpRows.filter(r => r.team === r.winningTeam).length;

        // Live waiting context: queue position (1-based), courts currently
        // in play (with startedAt for the elapsed-time strip), and the
        // player's most recent finished game in this session.
        let queuePosition: number | null = null;
        try {
          const queue = await storage.getQueue(activeSession.id);
          const idx = queue.indexOf(linkedPlayerId);
          queuePosition = idx >= 0 ? idx + 1 : null;
        } catch (qErr) {
          console.error('[today-stats] queue lookup failed:', qErr);
        }

        let courtsInPlay: Array<{ id: string; name: string; startedAt: string | null }> = [];
        try {
          const allCourts = await storage.getCourtsBySession(activeSession.id);
          courtsInPlay = allCourts
            .filter(c => c.status === 'occupied')
            .map(c => ({
              id: c.id,
              name: c.name,
              startedAt: c.startedAt ? c.startedAt.toISOString() : null,
            }));
        } catch (cErr) {
          console.error('[today-stats] courts lookup failed:', cErr);
        }

        let lastGame:
          | {
              gameId: string;
              won: boolean;
              myScore: number;
              theirScore: number;
              partnerName: string | null;
              opponentNames: string[];
            }
          | null = null;
        try {
          const [recent] = await db
            .select({
              gameId: gameResults.id,
              team1Score: gameResults.team1Score,
              team2Score: gameResults.team2Score,
              winningTeam: gameResults.winningTeam,
              myTeam: gameParticipants.team,
            })
            .from(gameParticipants)
            .innerJoin(gameResults, eq(gameParticipants.gameId, gameResults.id))
            .where(and(
              eq(gameParticipants.playerId, linkedPlayerId),
              eq(gameResults.sessionId, activeSession.id),
            ))
            .orderBy(desc(gameResults.createdAt))
            .limit(1);

          if (recent) {
            const others = await db
              .select({
                playerId: gameParticipants.playerId,
                team: gameParticipants.team,
                name: players.name,
              })
              .from(gameParticipants)
              .innerJoin(players, eq(players.id, gameParticipants.playerId))
              .where(eq(gameParticipants.gameId, recent.gameId));

            const partner = others.find(o => o.team === recent.myTeam && o.playerId !== linkedPlayerId);
            const opponents = others.filter(o => o.team !== recent.myTeam);
            const myScore = recent.myTeam === 1 ? recent.team1Score : recent.team2Score;
            const theirScore = recent.myTeam === 1 ? recent.team2Score : recent.team1Score;
            lastGame = {
              gameId: recent.gameId,
              won: recent.myTeam === recent.winningTeam,
              myScore,
              theirScore,
              partnerName: partner?.name ?? null,
              opponentNames: opponents.map(o => o.name),
            };
          }
        } catch (lgErr) {
          console.error('[today-stats] last game lookup failed:', lgErr);
        }

        return res.json({
          gamesPlayed,
          wins,
          skillScore,
          tierName,
          queuePosition,
          courtsInPlay,
          lastGame,
        });
      } catch (error) {
        console.error('[GET /api/marketplace/players/me/today-stats] error:', error);
        return res.status(500).json({ error: "Couldn't load today's stats." });
      }
    },
  );

  // Returns the people already checked in for a given bookable session, so
  // the check-in screen can render an avatar rail of "who else is here".
  // No auth-side filtering — any authenticated marketplace user can see it
  // for any bookable session (no sensitive data; mirrors what's already
  // visible in the public roster). Includes attended primary bookers and
  // their attended guests. Self is included; the frontend can choose to
  // hide it.
  app.get(
    "/api/marketplace/sessions/:bookableSessionId/checked-in",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const { bookableSessionId } = req.params;
        const userId = req.user!.userId;

        // Authorization: caller must hold a confirmed or attended
        // booking for this session. Waitlisted / pending-payment
        // bookings don't yet entitle the holder to see who else is
        // there. This prevents arbitrary session attendance enumeration.
        const callerBooking = await storage.getUserBookingForSession(
          userId,
          bookableSessionId,
        );
        const allowedStatuses = new Set(['confirmed', 'attended']);
        if (!callerBooking || !allowedStatuses.has(callerBooking.status)) {
          return res.status(404).json({ error: 'Not found.' });
        }

        // Primary bookers who are checked in.
        const primaryRows = await db
          .select({
            userId: bookings.userId,
            name: marketplaceUsers.name,
            photoUrl: marketplaceUsers.photoUrl,
          })
          .from(bookings)
          .innerJoin(marketplaceUsers, eq(marketplaceUsers.id, bookings.userId))
          .where(and(
            eq(bookings.sessionId, bookableSessionId),
            eq(bookings.status, 'attended'),
          ));

        // Guests who are checked in (booking is attended; guest itself is
        // not cancelled). Guests don't carry photo URLs, so the rail
        // renders an initials fallback.
        const guestRows = await db
          .select({
            id: bookingGuests.id,
            name: bookingGuests.name,
          })
          .from(bookingGuests)
          .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
          .where(and(
            eq(bookings.sessionId, bookableSessionId),
            eq(bookings.status, 'attended'),
            sql`${bookingGuests.cancelledAt} IS NULL`,
            sql`${bookingGuests.isPrimary} = false`,
          ));

        const players: Array<{ id: string; name: string; photoUrl: string | null }> = [
          ...primaryRows.map(r => ({ id: r.userId, name: r.name, photoUrl: r.photoUrl ?? null })),
          ...guestRows.map(r => ({ id: r.id, name: r.name, photoUrl: null })),
        ];

        return res.json({ players });
      } catch (error) {
        console.error('[GET /api/marketplace/sessions/:id/checked-in] error:', error);
        return res.status(500).json({ error: "Couldn't load checked-in players." });
      }
    },
  );

  // P9 — Session End Screen.
  // Returns the player's stats for the most recent session they actually
  // attended. "Attended" is gated on bookings.status === 'attended', joined
  // through bookable_sessions to find the corresponding internal session id.
  // From there we count game_participants rows for this player in that
  // session's games (gamesPlayed / wins) and use the EARLIEST
  // skill_score_before in that session as the per-session baseline so the
  // delta reflects what changed during the session, not lifetime drift.
  //
  // Three terminal shapes:
  //   { noSession: true }                 — never attended a session, or the
  //                                         attended booking is for a
  //                                         bookable_session with no
  //                                         linked internal session.
  //   { ...stats, gamesPlayed: 0, ... }   — checked in but never assigned to
  //                                         a court (skillScoreDelta is 0
  //                                         and the frontend renders the
  //                                         graceful "didn't play" state).
  //   { ...stats }                        — full summary.
  app.get(
    "/api/marketplace/players/me/session-summary",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      try {
        const userId = req.user!.userId;
        const user = await storage.getMarketplaceUser(userId);
        const linkedPlayerId = user?.linkedPlayerId ?? null;
        if (!linkedPlayerId) {
          return res.json({ noSession: true });
        }

        // Most recent attended booking, joined through bookable_sessions to
        // resolve to the internal session id we use for game lookups.
        // attendedAt is set by the /attend admin action — we order by it so
        // ties between bookings created earlier in the day are broken by
        // the actual check-in moment.
        const [attendedBooking] = await db
          .select({
            internalSessionId: bookableSessions.linkedSessionId,
            attendedAt: bookings.attendedAt,
          })
          .from(bookings)
          .innerJoin(bookableSessions, eq(bookings.sessionId, bookableSessions.id))
          .where(and(
            eq(bookings.userId, userId),
            eq(bookings.status, 'attended'),
            sql`${bookableSessions.linkedSessionId} IS NOT NULL`,
            sql`${bookings.attendedAt} IS NOT NULL`,
          ))
          .orderBy(desc(bookings.attendedAt))
          .limit(1);

        if (!attendedBooking || !attendedBooking.internalSessionId) {
          return res.json({ noSession: true });
        }

        const internalSessionId = attendedBooking.internalSessionId;

        const player = await storage.getPlayer(linkedPlayerId);
        if (!player) {
          return res.json({ noSession: true });
        }

        // Per-game rows for this player in this session, ordered by game
        // creation so [0] is the earliest skill_score_before (session
        // baseline). team is the player's team in that game; winningTeam
        // comes from game_results.
        const gpRows = await db
          .select({
            team: gameParticipants.team,
            winningTeam: gameResults.winningTeam,
            skillScoreBefore: gameParticipants.skillScoreBefore,
          })
          .from(gameParticipants)
          .innerJoin(gameResults, eq(gameParticipants.gameId, gameResults.id))
          .where(and(
            eq(gameParticipants.playerId, linkedPlayerId),
            eq(gameResults.sessionId, internalSessionId),
          ))
          .orderBy(asc(gameResults.createdAt));

        const gamesPlayed = gpRows.length;
        const wins = gpRows.filter(r => r.team === r.winningTeam).length;
        const winRate = gamesPlayed > 0
          ? Math.round((wins / gamesPlayed) * 100)
          : 0;

        // Session anchor for the delta — the player's skill score at the
        // moment their first game of this session began. Falls back to 0
        // when the player checked in but never played (UI handles that as
        // a separate state via gamesPlayed === 0).
        const skillScoreDelta = gpRows.length > 0
          ? player.skillScore - gpRows[0].skillScoreBefore
          : 0;

        // Rank — must match the Profile screen exactly, otherwise the
        // player will see different ranks back-to-back when they tap
        // "See full profile". The Profile screen uses storage.getPlayerStats
        // which sorts all players by skill_score desc and takes
        // `findIndex(...) + 1` (ordinal ranking, ties resolved by the
        // sort's stable order on the player rows). We deliberately mirror
        // that algorithm here rather than using a strictly-higher-count
        // SQL trick, so the two surfaces can never disagree.
        const allSortedBySkill = await db
          .select({ id: players.id })
          .from(players)
          .orderBy(desc(players.skillScore));
        const totalPlayers = allSortedBySkill.length;
        const idx = allSortedBySkill.findIndex(p => p.id === linkedPlayerId);
        const rankBySkillScore = idx >= 0 ? idx + 1 : totalPlayers;

        // Tier display name. The DB stores a mix of capitalised
        // ('Novice', 'Beginner', 'Advanced', 'Professional') and snake_case
        // ('lower_intermediate', 'upper_intermediate') — normalise both.
        const tierName = tierDisplayName(player.level);

        return res.json({
          playerName: player.name,
          gamesPlayed,
          wins,
          winRate,
          skillScoreDelta,
          currentSkillScore: player.skillScore,
          tierName,
          rankBySkillScore,
          totalPlayers,
        });
      } catch (error) {
        console.error('[Session summary] error:', error);
        res.status(500).json({ error: "Could not load your session summary. Please ask the Court Captain for help." });
      }
    },
  );

  // Admin: toggle cash paid status
  app.patch("/api/marketplace/bookings/:id/cash-paid", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.paymentMethod !== 'cash') return res.status(400).json({ error: "Only cash bookings can be toggled" });

      const { cashPaid } = req.body;
      const updated = await storage.updateBooking(req.params.id, { cashPaid: !!cashPaid });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update cash payment status" });
    }
  });

  // Admin: force-confirm a pending Ziina booking (escape hatch when Ziina timing caused status to get stuck)
  app.post("/api/marketplace/bookings/:id/admin-confirm", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.paymentMethod === 'cash') return res.status(400).json({ error: "Use the cash-paid toggle for cash bookings" });
      if (booking.status === 'confirmed' || booking.status === 'attended') {
        return res.json({ message: "Booking already confirmed", booking });
      }

      // Try to fetch latest Ziina status first; log it for audit purposes
      let ziinaStatus = 'unknown';
      if (booking.ziinaPaymentIntentId) {
        try {
          const intent = await retrieveZiinaPaymentIntent(booking.ziinaPaymentIntentId);
          ziinaStatus = intent.status;
          console.log(`[Admin confirm] Booking ${booking.id} — Ziina status at confirm time: "${ziinaStatus}"`);
        } catch (zErr) {
          console.warn(`[Admin confirm] Could not fetch Ziina status for booking ${booking.id}:`, zErr);
        }
      }

      await storage.updateBooking(booking.id, { status: 'confirmed' });

      // Record the payment if not already present
      if (booking.ziinaPaymentIntentId) {
        const existingPayments = await storage.getPaymentsByBookingId(booking.id);
        const alreadyRecorded = existingPayments.some(p => p.ziinaPaymentIntentId === booking.ziinaPaymentIntentId);
        if (!alreadyRecorded) {
          await storage.createPayment({
            bookingId: booking.id,
            ziinaPaymentIntentId: booking.ziinaPaymentIntentId,
            amount: booking.amountAed,
            currency: 'aed',
            status: 'completed',
          });
        }
      }

      // Confirm all pending guest slots and send guest emails/notifications
      try {
        const user = await storage.getMarketplaceUser(booking.userId);
        const session = await storage.getBookableSession(booking.sessionId);
        if (user && session) {
          sendBookingConfirmationEmail(user.email, user.name, session, 'ziina', booking.amountAed).catch(() => {});

          const adminConfirmBaseUrl = process.env.REPLIT_DOMAINS
            ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
            : 'http://localhost:5000';
          const pendingSlots = await storage.getBookingGuests(booking.id);
          for (const slot of pendingSlots) {
            if (slot.status === 'pending') {
              await storage.updateBookingGuest(slot.id, { status: 'confirmed' });
              // Send guest email for non-primary slots with a cancellation token
              if (!slot.isPrimary && slot.email && slot.cancellationToken) {
                const cancelGuestUrl = `${adminConfirmBaseUrl}/marketplace/guests/cancel/${slot.cancellationToken}`;
                const signupUrl = `${adminConfirmBaseUrl}/marketplace/signup?email=${encodeURIComponent(slot.email)}`;
                sendGuestBookingEmail(slot.email, slot.name, user.name, session, cancelGuestUrl, signupUrl).catch(() => {});
              }
              // Notify linked non-primary guests
              if (!slot.isPrimary && slot.linkedUserId) {
                await storage.createMarketplaceNotification({
                  userId: slot.linkedUserId,
                  type: 'guest_booking_confirmed',
                  title: 'You have a booking!',
                  message: `${user.name} added you as a guest for "${session.title}" on ${new Date(session.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${session.venueName}.`,
                  relatedBookingId: booking.id,
                });
              }
            }
          }
        }
      } catch (emailErr) { console.error('[Email] admin-confirm email failed:', emailErr); }

      const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
      res.json({ confirmed: true, ziinaStatus, booking: bookingWithDetails });
    } catch (error: any) {
      console.error('Admin confirm error:', error);
      res.status(500).json({ error: "Failed to confirm booking" });
    }
  });

  // Admin: manually promote a waitlisted booking when capacity opens up
  app.post("/api/marketplace/bookings/:id/admin-promote", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const booking = await storage.getBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status !== 'waitlisted') {
        return res.status(400).json({ error: "Booking is not waitlisted" });
      }

      const bookableSession = await storage.getBookableSession(booking.sessionId);
      if (!bookableSession) return res.status(404).json({ error: "Session not found" });

      // Check capacity: count confirmed/attended/pending_payment spots
      const currentCount = await storage.getBookingCountForSession(booking.sessionId);
      const spotsNeeded = booking.spotsBooked ?? 1;
      if (currentCount + spotsNeeded > bookableSession.capacity) {
        return res.status(409).json({ error: "session_full", message: "Session is still full — cancel another booking first." });
      }

      // Promote the booking
      await storage.updateBooking(booking.id, {
        status: 'confirmed',
        waitlistPosition: null,
        promotedAt: new Date(),
      });

      // Confirm all pending guest slots (leave cancelled slots untouched)
      const slots = await storage.getBookingGuests(booking.id);
      for (const slot of slots) {
        if (slot.status === 'pending') {
          await storage.updateBookingGuest(slot.id, { status: 'confirmed' });
        }
      }

      // Re-number remaining waitlisted bookings for this session
      const stillWaitlisted = await storage.getWaitlistedBookingsForSession(booking.sessionId);
      for (let i = 0; i < stillWaitlisted.length; i++) {
        await storage.updateBooking(stillWaitlisted[i].id, { waitlistPosition: i + 1 });
      }

      // Send confirmation email (fire-and-forget)
      try {
        const user = await storage.getMarketplaceUser(booking.userId);
        if (user) {
          sendBookingConfirmationEmail(user.email, user.name, bookableSession, booking.paymentMethod as 'ziina' | 'cash', booking.amountAed).catch(() => {});
        }
      } catch (emailErr) { console.error('[Email] admin-promote email failed:', emailErr); }

      const bookingWithDetails = await storage.getBookingWithDetails(booking.id);
      res.json({ confirmed: true, booking: bookingWithDetails });
    } catch (error: any) {
      console.error('Admin promote error:', error);
      res.status(500).json({ error: "Failed to promote booking" });
    }
  });

  // Public (authenticated players): get confirmed player list for a session
  app.get("/api/marketplace/sessions/:id/players", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const sessionBookings = await storage.getSessionBookings(req.params.id);
      const confirmedBookings = sessionBookings.filter(b => b.status === 'confirmed' || b.status === 'attended');

      const playerEntries: Array<{ name: string; level: string | null; skillScore: number | null; linkedPlayerId: string | null; photoUrl: string | null; isGuest?: boolean }> = [];

      for (const booking of confirmedBookings) {
        let level: string | null = null;
        let skillScore: number | null = null;

        if (booking.user?.linkedPlayerId) {
          const player = await storage.getPlayer(booking.user.linkedPlayerId);
          if (player) {
            level = player.level ?? null;
            skillScore = player.skillScore ?? null;
          }
        }

        // Main booker
        playerEntries.push({
          name: booking.user?.name ?? 'Player',
          level,
          skillScore,
          linkedPlayerId: booking.user?.linkedPlayerId ?? null,
          photoUrl: booking.user?.photoUrl ?? null,
        });

        // Additional guests only (exclude primary slot — already represented above by booking.user)
        const guestList = booking.guests ?? [];
        for (const guest of guestList) {
          if (guest.status === 'confirmed' && !guest.isPrimary) {
            let guestLevel: string | null = null;
            let guestSkillScore: number | null = null;
            let guestLinkedPlayerId: string | null = null;
            let guestPhotoUrl: string | null = null;
            // If guest has a linked marketplace user, resolve their linked player
            if (guest.linkedUserId) {
              const guestUser = await storage.getMarketplaceUser(guest.linkedUserId);
              if (guestUser) {
                guestPhotoUrl = guestUser.photoUrl ?? null;
              }
              if (guestUser?.linkedPlayerId) {
                const guestPlayer = await storage.getPlayer(guestUser.linkedPlayerId);
                if (guestPlayer) {
                  guestLevel = guestPlayer.level ?? null;
                  guestSkillScore = guestPlayer.skillScore ?? null;
                  guestLinkedPlayerId = guestPlayer.id;
                }
              }
            }
            playerEntries.push({
              name: guest.name,
              level: guestLevel,
              skillScore: guestSkillScore,
              linkedPlayerId: guestLinkedPlayerId,
              photoUrl: guestPhotoUrl,
              isGuest: true,
            });
          }
        }
      }

      res.json(playerEntries);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch players" });
    }
  });

  // Admin: get bookings for a session
  app.get("/api/marketplace/sessions/:id/bookings", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const bookings = await storage.getSessionBookings(req.params.id);
      res.json(bookings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  // Admin: get all marketplace users
  app.get("/api/marketplace/admin/users", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const users = await storage.getAllMarketplaceUsers();
      const usersWithPlayers = await Promise.all(
        users.map(async (u) => {
          let linkedPlayer = null;
          if (u.linkedPlayerId) {
            linkedPlayer = await storage.getPlayer(u.linkedPlayerId);
          }
          return {
            id: u.id,
            email: u.email,
            name: u.name,
            phone: u.phone,
            linkedPlayerId: u.linkedPlayerId,
            linkedPlayer,
            createdAt: u.createdAt,
          };
        })
      );
      res.json(usersWithPlayers);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // ============================================================
  // NOTIFICATIONS
  // ============================================================

  app.get("/api/marketplace/notifications", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const notifications = await storage.getNotificationsForUser(req.user.userId);
      const unreadCount = notifications.filter(n => !n.read).length;
      res.json({ notifications, unreadCount });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.post("/api/marketplace/notifications/read-all", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      await storage.markAllNotificationsRead(req.user.userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notifications as read" });
    }
  });

  app.post("/api/marketplace/notifications/:id/read", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      await storage.markNotificationRead(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  // ============================================================
  // SCORE DISPUTES
  // ============================================================

  // Flag a score for admin review (marketplace player). Idempotent: a repeat
  // flag from the same user for the same game returns the existing dispute
  // with a 200 instead of creating a duplicate. Distinct from the older
  // /dispute endpoint, which 409s on duplicates.
  app.post("/api/marketplace/games/:gameResultId/flag", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const { gameResultId } = req.params;
      const userId = req.user!.userId;
      const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body);

      // Game must exist. Player-facing copy uses "Court Captain" wording so
      // the marketplace UI stays consistent with the rest of the product.
      const game = await storage.getGameResult(gameResultId);
      if (!game) {
        return res.status(404).json({ error: "We can't find that game — it may have been removed. Reach out to your Court Captain if you think this is a mistake." });
      }

      // Flagger must be a participant. We resolve the marketplace user's
      // linked player and check that against the game's participant rows.
      const user = await storage.getMarketplaceUser(userId);
      if (!user?.linkedPlayerId) {
        return res.status(403).json({ error: "Only players who were on court for this game can flag the score. Ask your Court Captain if you need a correction." });
      }
      const participants = await storage.getGameParticipants(gameResultId);
      const isParticipant = participants.some(p => p.playerId === user.linkedPlayerId);
      if (!isParticipant) {
        return res.status(403).json({ error: "Only players who were on court for this game can flag the score. Ask your Court Captain if you need a correction." });
      }

      // Fast path for the common repeat-flag case (no transaction needed).
      const existing = await storage.getDisputeByUserAndGame(userId, gameResultId);
      if (existing) {
        return res.status(200).json({ success: true, disputeId: existing.id, alreadyFlagged: true });
      }

      // Atomic insert + first-flag detection. The SELECT FOR UPDATE inside
      // createScoreDisputeAtomic also collapses the same-user concurrent
      // race: the loser sees its own dispute and gets alreadyFlagged=true
      // with no second insert and no admin fan-out.
      const { dispute, isFirstForGame, alreadyFlagged } = await storage.createScoreDisputeAtomic({ gameResultId, filedByUserId: userId, note });

      if (alreadyFlagged) {
        return res.status(200).json({ success: true, disputeId: dispute.id, alreadyFlagged: true });
      }

      if (isFirstForGame) {
        try {
          const admins = await storage.listMarketplaceAdmins();
          const playerName = user.name;
          await Promise.all(admins.map(admin =>
            storage.createMarketplaceNotification({
              userId: admin.id,
              type: 'score_flag',
              title: 'Score flagged for review',
              message: `${playerName} flagged the score of game ${gameResultId.slice(0, 8)} for Court Captain review.`,
            }).catch(err => console.error('[Score flag] notify admin failed:', err))
          ));
        } catch (notifyErr) {
          console.error('[Score flag] admin notification batch failed:', notifyErr);
        }
      }

      res.status(200).json({ success: true, disputeId: dispute.id, alreadyFlagged: false });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request body", details: err.errors });
      }
      console.error('[Score flag] error:', err);
      res.status(500).json({ error: "Failed to flag score" });
    }
  });

  // File a dispute (marketplace player)
  app.post("/api/marketplace/game-results/:gameResultId/dispute", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const { gameResultId } = req.params;
      const userId = req.user!.userId;
      const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body);

      const existing = await storage.getDisputeByUserAndGame(userId, gameResultId);
      if (existing) {
        return res.status(409).json({ error: "You have already filed a dispute for this game." });
      }

      const dispute = await storage.createScoreDispute({ gameResultId, filedByUserId: userId, note });
      res.status(201).json(dispute);
    } catch (err) {
      res.status(500).json({ error: "Failed to file dispute" });
    }
  });

  // Get current user's disputes (marketplace player)
  app.get("/api/marketplace/my-disputes", requireAuth, requireMarketplaceAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.userId;
      const disputes = await storage.getDisputesByUser(userId);
      res.json(disputes);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch disputes" });
    }
  });

  // Get all disputes (admin)
  app.get("/api/disputes", requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
    try {
      const disputes = await storage.getAllDisputesWithDetails();
      res.json(disputes);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch disputes" });
    }
  });

  // Resolve or dismiss a dispute (admin)
  app.patch("/api/disputes/:id", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const { status, adminNote } = z.object({
        status: z.enum(['resolved', 'dismissed']),
        adminNote: z.string().max(500).optional(),
      }).parse(req.body);

      const dispute = await storage.getScoreDispute(id);
      if (!dispute) return res.status(404).json({ error: "Dispute not found" });

      const updated = await storage.updateScoreDispute(id, { status, adminNote: adminNote ?? null });

      // Send email notification to the player
      try {
        const user = await storage.getMarketplaceUser(dispute.filedByUserId);
        if (user) {
          // Get dispute details for the email
          const allDisputes = await storage.getAllDisputesWithDetails();
          const detail = allDisputes.find(d => d.id === id);
          if (detail) {
            await sendDisputeResolutionEmail(user.email, {
              playerName: user.name,
              status,
              gameScore: detail.gameScore,
              gameDate: detail.gameDate,
              adminNote: adminNote ?? null,
            });
          }
        }
      } catch (emailErr) {
        console.error('[Email] Failed to send dispute resolution email:', emailErr);
      }

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update dispute" });
    }
  });

  // ============================================================
  // ADMIN: REFUNDS
  // ============================================================

  app.get("/api/marketplace/admin/refunds", requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
    try {
      const refunds = await storage.getRefundNotifications();
      res.json(refunds);
    } catch (error) {
      console.error('Failed to fetch refund notifications:', error);
      res.status(500).json({ error: "Failed to fetch refunds" });
    }
  });

  app.patch("/api/marketplace/admin/refunds/:id/resolve", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const updated = await storage.resolveRefundNotification(id);
      if (!updated) return res.status(404).json({ error: "Refund notification not found" });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to resolve refund notification:', error);
      res.status(500).json({ error: "Failed to resolve refund" });
    }
  });

  // ============================================================
  // SEED DATA
  // ============================================================

  app.post("/api/marketplace/seed", requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
    try {
      const existing = await storage.getAllBookableSessions();
      if (existing.length > 0) {
        return res.json({ message: "Seed data already exists", count: existing.length });
      }

      const now = new Date();
      const sessions = [
        {
          title: "Friday Evening Drop-in",
          description: "Casual drop-in session for all skill levels. Great for meeting new players and getting some games in after work.",
          venueName: "Dubai Sports World",
          venueLocation: "Dubai World Trade Centre, Hall 4",
          date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
          startTime: "18:00",
          endTime: "21:00",
          courtCount: 4,
          capacity: 20,
          priceAed: 45,
          status: "upcoming" as const,
          imageUrl: null,
        },
        {
          title: "Weekend Warriors Tournament",
          description: "Competitive doubles tournament for intermediate and advanced players. Prizes for top 3 teams!",
          venueName: "Shuttlers Club",
          venueLocation: "Al Quoz Industrial Area 3",
          date: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
          startTime: "09:00",
          endTime: "14:00",
          courtCount: 6,
          capacity: 24,
          priceAed: 75,
          status: "upcoming" as const,
          imageUrl: null,
        },
        {
          title: "Beginners Welcome Session",
          description: "Perfect for newcomers to badminton. Includes a 30-minute coaching warm-up followed by supervised games.",
          venueName: "NAS Sports Complex",
          venueLocation: "Al Quoz, Dubai",
          date: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          startTime: "10:00",
          endTime: "12:00",
          courtCount: 3,
          capacity: 12,
          priceAed: 35,
          status: "upcoming" as const,
          imageUrl: null,
        },
        {
          title: "Midweek Smash Night",
          description: "High-energy midweek session. Fast-paced rotation format ensures maximum court time for everyone.",
          venueName: "Dubai Sports World",
          venueLocation: "Dubai World Trade Centre, Hall 4",
          date: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
          startTime: "19:00",
          endTime: "22:00",
          courtCount: 4,
          capacity: 16,
          priceAed: 50,
          status: "upcoming" as const,
          imageUrl: null,
        },
        {
          title: "Ladies Only Session",
          description: "Exclusive session for female players of all levels. Supportive and fun environment.",
          venueName: "Hamdan Sports Complex",
          venueLocation: "Al Nasr, Dubai",
          date: new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000),
          startTime: "17:00",
          endTime: "19:00",
          courtCount: 3,
          capacity: 12,
          priceAed: 40,
          status: "upcoming" as const,
          imageUrl: null,
        },
      ];

      for (const s of sessions) {
        await storage.createBookableSession(s);
      }

      res.json({ message: "Seed data created", count: sessions.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to seed data" });
    }
  });

  // ============================================================
  // ADMIN: Register Ziina webhook (one-time setup)
  // ============================================================

  app.post("/api/admin/ziina/register-webhook", requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const webhookSecret = process.env.ZIINA_WEBHOOK_SECRET;
      if (!webhookSecret) {
        return res.status(400).json({
          error: "ZIINA_WEBHOOK_SECRET is not set. Add it to Replit Secrets first.",
        });
      }

      const baseUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
        : `http://localhost:${process.env.PORT || 5000}`;

      const webhookUrl = `${baseUrl}/api/webhooks/ziina`;
      console.log(`[Admin] Registering Ziina webhook at: ${webhookUrl}`);

      const result = await registerZiinaWebhook(webhookUrl, webhookSecret);
      res.json({ registered: true, webhookUrl, ziina: result });
    } catch (err: any) {
      console.error("[Admin] Ziina webhook registration failed:", err);
      res.status(500).json({ error: err.message || "Failed to register Ziina webhook" });
    }
  });

  // ─── P7: Marketplace player starts the game from their phone ────────────
  // POST /api/marketplace/games/:suggestionId/start-game
  // No body. Any of the 4 players on the suggestion can call this. Atomic
  // CAS in storage.startApprovedSuggestion guarantees that simultaneous
  // taps from multiple players collapse into exactly one state transition;
  // the losers receive { alreadyStarted: true } and skip the side effects.
  app.post(
    "/api/marketplace/games/:suggestionId/start-game",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      const suggestionId = req.params.suggestionId;
      try {
        // 1. Resolve caller's linked player. Marketplace users without a
        //    linked player can't be on a court roster, so we treat this
        //    as if the suggestion does not exist for them — same 404 the
        //    non-member arm uses below, so we never disclose whether a
        //    given suggestionId is real to a non-participant.
        const me = await storage.getMarketplaceUser(req.user!.userId);
        if (!me || !me.linkedPlayerId) {
          return res.status(404).json({ error: "Match not found. Please ask the Court Captain for the next lineup." });
        }

        // 2. Authorization via direct PK lookup on match_suggestion_players
        //    (matches the submit-score pattern — O(1), index-friendly).
        //    We do NOT first probe the suggestion row by id, so unknown
        //    suggestionIds and known-but-not-yours suggestionIds collapse
        //    to the same 404 response — preventing existence enumeration.
        const [membership] = await db
          .select({ team: matchSuggestionPlayers.team })
          .from(matchSuggestionPlayers)
          .where(
            and(
              eq(matchSuggestionPlayers.suggestionId, suggestionId),
              eq(matchSuggestionPlayers.playerId, me.linkedPlayerId),
            ),
          )
          .limit(1);
        if (!membership) {
          return res.status(404).json({ error: "Match not found. Please ask the Court Captain for the next lineup." });
        }

        // 3. Atomic CAS approved → playing PLUS every downstream side
        //    effect (court status, court_players, player status, queue
        //    removal) inside one storage-level transaction. The race
        //    winner returns 'started'; concurrent taps from the other
        //    three players return 'already-started' and short-circuit
        //    here without reapplying any state.
        const startResult = await storage.startApprovedSuggestion(suggestionId);

        if (startResult.result === 'not-found') {
          return res.status(404).json({ error: "Match not found. Please ask the Court Captain for the next lineup." });
        }
        if (startResult.result === 'already-started') {
          return res.json({ success: true, alreadyStarted: true });
        }
        if (startResult.result === 'not-startable') {
          return res.status(409).json({
            error: "This match is no longer available. Looking for your next game…",
            status: startResult.suggestion.status,
          });
        }

        return res.json({ success: true, alreadyStarted: false });
      } catch (err) {
        console.error('[POST /api/marketplace/games/:suggestionId/start-game] error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Couldn't start the game. Please try again." });
        }
      }
    },
  );

  // ─── P3: Marketplace player submits the score for a played match ─────────
  // POST /api/marketplace/games/:suggestionId/submit-score
  // Body: { team1Score: int, team2Score: int, winningTeam: 1 | 2 }
  // Idempotent on matchSuggestionId via game_results UNIQUE constraint.
  // Responds <500ms; fires background AI matchmaking after the response.
  app.post(
    "/api/marketplace/games/:suggestionId/submit-score",
    requireAuth,
    requireMarketplaceAuth,
    async (req: AuthRequest, res) => {
      const suggestionId = req.params.suggestionId;
      try {
        // 1. Resolve caller's linked player FIRST. Marketplace users without
        //    a linked player can't possibly be on a court roster, so we can
        //    reject them before any suggestion lookup.
        const me = await storage.getMarketplaceUser(req.user!.userId);
        if (!me || !me.linkedPlayerId) {
          return res.status(403).json({ error: "Your account isn't linked to a player profile. Ask the Court Captain to link you before submitting scores." });
        }

        // 2. Load the suggestion. Genuine missing => 404 (per API contract).
        const suggestion = await storage.getMatchSuggestion(suggestionId);
        if (!suggestion) {
          return res.status(404).json({ error: "Match not found. Please confirm with the Court Captain." });
        }

        // 3. Authorization via the indexed match_suggestion_players PK
        //    (suggestion_id, player_id) — a direct lookup rather than scanning
        //    suggestion.players in JS, so it stays O(1) regardless of roster
        //    size and exercises the join-table primary key index.
        const [membership] = await db
          .select({ team: matchSuggestionPlayers.team })
          .from(matchSuggestionPlayers)
          .where(
            and(
              eq(matchSuggestionPlayers.suggestionId, suggestionId),
              eq(matchSuggestionPlayers.playerId, me.linkedPlayerId),
            ),
          )
          .limit(1);
        if (!membership) {
          return res.status(403).json({ error: "You weren't on this court. Only the four players in the match can submit the score for the Court Captain." });
        }

        // 4. Status gate.
        //    SUBMITTABLE STATES: 'approved', 'playing', 'completed'.
        //    'completed' is intentionally allowed (despite the spec's
        //    "approved/playing only" wording) so that an idempotent
        //    retry from any of the four players against an already-
        //    completed suggestion still receives the canonical
        //    { alreadySubmitted: true, gameResultId } response. Without
        //    this, a network blip on the first submitter's request would
        //    confuse the second player with a "no longer active" error.
        //    The transaction's UNIQUE constraint on
        //    game_results.matchSuggestionId is the single source of
        //    truth for idempotency. Atomicity inside the tx guarantees
        //    status='completed' ↔ a game_results row exists, so no
        //    separate route-level pre-check is needed.
        if (
          suggestion.status !== 'approved' &&
          suggestion.status !== 'playing' &&
          suggestion.status !== 'completed'
        ) {
          return res.status(400).json({ error: "This match is no longer active. Please ask the Court Captain for the next lineup." });
        }

        // 5. Validate body shape.
        const parsed = submitScoreBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid score payload. team1Score and team2Score must be non-negative integers and winningTeam must be 1 or 2." });
        }
        const { team1Score, team2Score, winningTeam } = parsed.data;
        if (team1Score === team2Score) {
          return res.status(400).json({ error: "Scores cannot be tied — please record the deciding rally with the Court Captain before submitting." });
        }
        const expectedWinner = team1Score > team2Score ? 1 : 2;
        if (winningTeam !== expectedWinner) {
          return res.status(400).json({ error: "winningTeam does not match the higher score. Double-check the result with the Court Captain." });
        }

        // 6. Resolve session + court (court row needed for status reset)
        const session = await storage.getSession(suggestion.sessionId);
        if (!session) {
          return res.status(400).json({ error: "Session not found. Please contact the Court Captain." });
        }
        const court = await storage.getCourt(suggestion.courtId);
        if (!court) {
          return res.status(404).json({ error: "Court not found. Please contact the Court Captain." });
        }
        const isSandboxSession = session.isSandbox;

        // 7. Build team rosters from suggestion.players (single source of truth)
        const team1Ids = suggestion.players.filter(p => p.team === 1).map(p => p.playerId);
        const team2Ids = suggestion.players.filter(p => p.team === 2).map(p => p.playerId);
        if (team1Ids.length !== 2 || team2Ids.length !== 2) {
          return res.status(400).json({ error: "Match lineup is invalid. Please contact the Court Captain." });
        }
        const winnerIds = winningTeam === 1 ? team1Ids : team2Ids;
        const loserIds = winningTeam === 1 ? team2Ids : team1Ids;
        const winnerIdSet = new Set(winnerIds);
        const teamByPlayerId = new Map<string, number>();
        team1Ids.forEach(id => teamByPlayerId.set(id, 1));
        team2Ids.forEach(id => teamByPlayerId.set(id, 2));
        const playerIds = [...team1Ids, ...team2Ids];

        // 8. Skill calc helpers (mirrors admin end-game)
        const { calculateSkillAdjustment, calculateTeamAverage, getSkillTier } =
          await import('@shared/utils/skillUtils');
        const pointDifferential = Math.abs(team1Score - team2Score);
        const now = new Date();
        const RETURN_BOOST_THRESHOLD_DAYS = 14;
        const RETURN_BOOST_GAMES = 2;

        // 9. Run the transactional game-completion. completeGameTransaction
        //    handles: idempotency via UNIQUE on game_results.matchSuggestionId,
        //    fresh-read of all 4 players inside the tx, player-stat updates,
        //    game_results + game_participants insert, and marking the
        //    match_suggestions row 'completed' — all in one db.transaction.
        const txResult = await storage.completeGameTransaction({
          sessionId: session.id,
          courtId: court.id,
          team1Score,
          team2Score,
          winningTeam,
          matchSuggestionId: suggestionId,
          isSandboxSession,
          playerIds,
          computePerPlayer: (freshPlayers) => {
            const freshTeam1 = freshPlayers.filter(p => teamByPlayerId.get(p.id) === 1);
            const freshTeam2 = freshPlayers.filter(p => teamByPlayerId.get(p.id) === 2);
            const team1AvgSkill = calculateTeamAverage(freshTeam1.map(p => p.skillScore || 50));
            const team2AvgSkill = calculateTeamAverage(freshTeam2.map(p => p.skillScore || 50));

            return freshPlayers.map(player => {
              const team = teamByPlayerId.get(player.id);
              if (team !== 1 && team !== 2) {
                throw new Error(`Player ${player.id} missing team assignment`);
              }
              const isWinner = winnerIdSet.has(player.id);
              const isTeam1 = team === 1;
              const opponentAvgSkill = isTeam1 ? team2AvgSkill : team1AvgSkill;

              const partnerScore = freshPlayers.find(
                p => teamByPlayerId.get(p.id) === team && p.id !== player.id,
              )?.skillScore ?? null;

              const lastPlayed = player.lastPlayedAt;
              const daysInactive = lastPlayed
                ? (now.getTime() - new Date(lastPlayed).getTime()) / (24 * 60 * 60 * 1000)
                : 0;
              const isReturning = lastPlayed !== null && daysInactive >= RETURN_BOOST_THRESHOLD_DAYS;
              const currentReturnGames = isReturning ? RETURN_BOOST_GAMES : (player.returnGamesRemaining ?? 0);
              const newReturnGamesRemaining = Math.max(0, currentReturnGames - 1);

              const skillBefore = player.skillScore || 50;
              const skillAfter = calculateSkillAdjustment(
                skillBefore,
                opponentAvgSkill,
                isWinner,
                pointDifferential,
                player.gamesPlayed || 0,
                partnerScore,
                currentReturnGames,
              );

              const tierResult = applyMarketplaceTierBuffer(
                { level: player.level, tierCandidate: player.tierCandidate ?? null, tierCandidateGames: player.tierCandidateGames ?? 0 },
                skillAfter,
                getSkillTier,
              );

              const playerUpdates = isSandboxSession
                ? { status: 'waiting' as const }
                : {
                    gamesPlayed: player.gamesPlayed + 1,
                    wins: isWinner ? player.wins + 1 : player.wins,
                    skillScore: skillAfter,
                    level: tierResult.level,
                    tierCandidate: tierResult.tierCandidate,
                    tierCandidateGames: tierResult.tierCandidateGames,
                    status: 'waiting' as const,
                    lastPlayedAt: now,
                    skillScoreBaseline: skillAfter,
                    returnGamesRemaining: newReturnGamesRemaining,
                  };

              return { playerId: player.id, team, skillBefore, skillAfter, playerUpdates };
            });
          },
        });

        // 10. Race-loser duplicate: two submissions arrived simultaneously,
        //     both passed the step-4 pre-check, but only one wins the
        //     game_results UNIQUE constraint inside completeGameTransaction.
        //     Return success without touching court / queue / rest states —
        //     those were already updated by the winning submission's caller.
        if (txResult.alreadySubmitted) {
          // Idempotent legacy-cleanup recovery — STRICTLY GUARDED.
          // Submit-score allows replays for already-'completed'
          // suggestions, so a delayed retry for an OLD game could
          // arrive after the same court has already moved on to a
          // newer 'playing' lineup. Wiping legacy court state in
          // that case would clobber the live game and create the
          // very split-brain we're closing. Only run the reset when
          // the court has NO active suggestion at all, or when its
          // active suggestion is THIS very one (i.e. the partial-
          // write window we want to recover). Non-idempotent side
          // effects (rest states, partner history, queue rebuild)
          // remain correctly skipped — they would double-count.
          try {
            const liveOnCourt = await storage.getActiveMatchSuggestionForCourt(court.id);
            const safeToRecover = !liveOnCourt || liveOnCourt.id === suggestionId;
            if (safeToRecover) {
              await storage.updateCourt(court.id, {
                status: 'available',
                timeRemaining: 0,
                winningTeam: null,
                startedAt: null,
              });
              await storage.setCourtPlayers(court.id, []);
            } else {
              console.log(`[submit-score] alreadySubmitted recovery skipped — court ${court.id} now hosts suggestion ${liveOnCourt.id}, not ${suggestionId}`);
            }
          } catch (recoveryErr) {
            console.error('[submit-score] alreadySubmitted legacy-recovery failed:', recoveryErr);
          }
          return res.json({
            success: true,
            gameResultId: txResult.gameId,
            alreadySubmitted: true,
          });
        }

        // First-time success: mirror admin end-game cleanup. Failures
        // propagate to the outer catch and surface as 500 so the client
        // retries — the retry hits the tx UNIQUE-constraint short-circuit
        // and re-runs this block.
        for (const playerId of playerIds) {
          updatePlayerRestState(session.id, playerId, true);
        }
        const team1Players = team1Ids.map(id => ({ id }));
        const team2Players = team2Ids.map(id => ({ id }));
        updatePartnerHistory(session.id, team1Players, team2Players);

        const currentQueue = await storage.getQueue(session.id);
        const playedSet = new Set(playerIds);
        for (const playerId of currentQueue) {
          if (!playedSet.has(playerId)) {
            updatePlayerRestState(session.id, playerId, false);
          }
        }
        const newQueue = [
          ...currentQueue.filter(id => !playedSet.has(id)),
          ...loserIds,
          ...winnerIds,
        ];
        await storage.setQueue(session.id, newQueue);

        await storage.updateCourt(court.id, {
          status: 'available',
          timeRemaining: 0,
          winningTeam: null,
          startedAt: null,
        });
        await storage.setCourtPlayers(court.id, []);
        await persistRestStatesToDb(session.id);

        // Queued → pending transition. If a 'queued' next-round lineup
        // exists for this court and all 4 named players are still
        // eligible, we flip it to 'pending' with a fresh 90s window
        // BEFORE the auto-matchmaker runs. This way tryAutoMatchmaking's
        // "court has in-flight suggestion" filter will respect the
        // pre-built lineup instead of replacing it. If eligibility
        // fails, the helper dismisses the queued row and the auto-
        // matchmaker is free to assign the court from scratch.
        try {
          await tryFlipQueuedToPendingForCourt(session.id, court.id);
        } catch (flipErr) {
          console.error('[queued-transition] post-score unhandled:', flipErr);
        }

        res.json({
          success: true,
          gameResultId: txResult.gameId,
          alreadySubmitted: false,
        });

        // Fire-and-forget session-wide matchmaking. The orchestrator decides
        // which courts get a fresh suggestion (the just-vacated one plus any
        // others currently free) and never re-suggests an in-flight court.
        setImmediate(() => {
          tryAutoMatchmaking(session.id).catch(err => {
            console.error('[auto-matchmaking] post-score unhandled:', err);
          });
        });
      } catch (err) {
        console.error('[POST /api/marketplace/games/:suggestionId/submit-score] error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to submit score. Please try again or contact the Court Captain." });
        }
      }
    },
  );
}
