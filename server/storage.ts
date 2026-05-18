import { 
  type Player, 
  type InsertPlayer, 
  type Court, 
  type InsertCourt,
  type CourtWithPlayers,
  type CourtPlayer,
  type Session,
  type InsertSession,
  type GameParticipant,
  type GameResult,
  type PlayerStats,
  type MarketplaceUser,
  type InsertMarketplaceUser,
  type BookableSession,
  type InsertBookableSession,
  type BookableSessionWithAvailability,
  type Booking,
  type InsertBooking,
  type BookingWithDetails,
  type BookingGuest,
  type InsertBookingGuest,
  type Payment,
  type InsertPayment,
  type MarketplaceNotification,
  type ScoreDispute,
  type ScoreDisputeWithDetails,
  type Tag,
  type InsertPlayerTag,
  type PlayerTag,
  type TrendingTag,
  type PlayerTopTag,
  type PlayerTopTagEntry,
  type CommunitySpotlightEntry,
  type ReceivedTagEntry,
  type TagCountResult,
  type GameParticipantInfo,
  type RefundNotificationWithDetails,
  type TagSuggestion,
  type InsertTagSuggestion,
  type TagSuggestionWithVote,
  type Referral,
  type InsertReferral,
  players,
  courts,
  courtPlayers as courtPlayersTable,
  queueEntries,
  sessions,
  gameResults,
  gameParticipants,
  marketplaceUsers,
  marketplaceAuthSessions,
  bookableSessions,
  bookings,
  bookingGuests,
  payments,
  marketplaceNotifications,
  scoreDisputes,
  tags,
  playerTags,
  tagSuggestions,
  tagSuggestionVotes,
  expenseCategories,
  expenses,
  referrals,
  type ExpenseCategory,
  type InsertExpenseCategory,
  type Expense,
  type InsertExpense,
  type ExpenseWithCategory,
  type FinanceSummary,
  type BlogPost,
  type InsertBlogPost,
  blogPosts,
  playerLinkOtps,
  type PlayerLinkOtp,
  playerContactChangeRequests,
  type PlayerContactChangeRequest,
  marketplaceUserContactChanges,
  type MarketplaceUserContactChange,
  paymentResumeTokens,
  type PaymentResumeToken,
  matchSuggestions,
  matchSuggestionPlayers,
  type MatchSuggestion,
  type MatchSuggestionPlayer,
  type InsertMatchSuggestion,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, inArray, desc, sql, asc, like, gte, lt, isNotNull, isNull, SQL } from "drizzle-orm";
import { randomUUID } from "crypto";
import { clearSessionRestStates, getSittingOutPlayers } from "./matchmaking";

// Helper function to add computed SKID to player object
function addSkidToPlayer(player: typeof players.$inferSelect): Player {
  return {
    ...player,
    skid: Math.floor(player.skillScore / 10)
  };
}

// Helper function to generate the next ShuttleIQ ID.
// Only considers IDs that strictly match the canonical "SIQ-#####" shape so a
// stray non-numeric ID (e.g. "SIQ-J-TZXX" from test data) cannot silently
// reset the counter back to 1 and cause unique-key collisions on insert.
async function generateShuttleIqId(): Promise<string> {
  // Use the strict 5-digit canonical shape so any malformed/test ID
  // (e.g. "SIQ-J-TZXX" or "SIQ-1") is excluded from the max calculation.
  const rows = await db
    .select({
      maxNum: sql<number | null>`MAX(CAST(SUBSTRING(${players.shuttleIqId} FROM '^SIQ-([0-9]{5})$') AS INTEGER))`,
      malformed: sql<number>`COUNT(*) FILTER (WHERE ${players.shuttleIqId} IS NOT NULL AND ${players.shuttleIqId} !~ '^SIQ-[0-9]{5}$')`,
    })
    .from(players)
    .where(sql`${players.shuttleIqId} ~ '^SIQ-[0-9]{5}$' OR ${players.shuttleIqId} IS NOT NULL`);

  const malformedCount = Number(rows[0]?.malformed ?? 0);
  if (malformedCount > 0) {
    console.warn(`[generateShuttleIqId] Ignoring ${malformedCount} non-canonical shuttle_iq_id value(s) when computing next ID`);
  }

  const maxNumRaw = rows[0]?.maxNum;
  const maxNum = typeof maxNumRaw === 'number'
    ? maxNumRaw
    : (maxNumRaw != null ? Number(maxNumRaw) : null);
  const nextNumber = (maxNum != null && Number.isFinite(maxNum) && maxNum > 0) ? maxNum + 1 : 1;

  const candidate = `SIQ-${nextNumber.toString().padStart(5, '0')}`;
  // Defense in depth: if somehow the candidate is already taken, advance
  // until we find a free slot rather than blowing up the whole insert.
  let probe = nextNumber;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const taken = await db.select({ id: players.id })
      .from(players)
      .where(eq(players.shuttleIqId, `SIQ-${probe.toString().padStart(5, '0')}`))
      .limit(1);
    if (taken.length === 0) {
      return `SIQ-${probe.toString().padStart(5, '0')}`;
    }
    probe += 1;
    if (probe - nextNumber > 1000) {
      // Safety valve — should never happen, but avoid an infinite loop.
      console.error('[generateShuttleIqId] Could not find free SIQ ID after 1000 probes from', candidate);
      throw new Error('Unable to allocate next ShuttleIQ ID');
    }
  }
}

function generateReferralCode(playerName: string, shuttleIqId: string | null): string {
  const cleanName = playerName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6).padEnd(6, 'X');
  const numericPart = shuttleIqId ? shuttleIqId.replace(/\D/g, '') : String(Math.floor(Math.random() * 99999));
  return `SIQ-${cleanName}-${numericPart}`;
}

// Return type for the public analytics endpoint
export type PublicAnalyticsResponse = {
  generatedAt: string;
  filters: { sessionId: string | null; from: string | null; to: string | null };
  totals: {
    confirmedBookings: number;
    totalSpotsBooked: number;
    revenueChargedAed: number;
    revenueCollectedAed: number;
    revenuePendingCashAed: number;
    cancelledBookings: number;
    lateFeesRetainedAed: number;
    waitlistedBookings: number;
    byPaymentMethod: {
      card: { bookings: number; spotsBooked: number; amountAed: number };
      cash: { bookings: number; spotsBooked: number; amountAed: number; collectedAed: number; pendingAed: number };
    };
  };
  sessions: Array<{
    id: string;
    title: string;
    date: Date;
    startTime: string;
    endTime: string;
    venue: string;
    pricePerSpotAed: number;
    capacity: number;
    confirmed: { bookings: number; spots: number; revenueAed: number; collectedAed: number; pendingCashAed: number };
    waitlisted: { bookings: number; spots: number };
    cancelled: { bookings: number; spots: number; lateFeesAed: number };
  }>;
  monthly: Array<{
    month: string;
    confirmedBookings: number;
    totalSpotsBooked: number;
    revenueChargedAed: number;
    revenueCollectedAed: number;
    revenuePendingCashAed: number;
  }>;
};

export interface IStorage {
  // Session operations
  createSession(session: InsertSession): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  getActiveSession(): Promise<Session | undefined>;
  getAllSessions(includeSandbox?: boolean): Promise<Session[]>;
  endSession(id: string): Promise<Session | undefined>;
  updateSession(id: string, updates: Partial<Session>): Promise<Session | undefined>;
  deleteSession(id: string): Promise<boolean>;
  
  // Player operations (global)
  getPlayer(id: string): Promise<Player | undefined>;
  getPlayerByExternalId(externalId: string): Promise<Player | undefined>;
  getPlayerByShuttleIqId(shuttleIqId: string): Promise<Player | undefined>;
  getAllPlayers(): Promise<Player[]>;
  searchPlayers(query: string): Promise<Player[]>;
  searchPlayersWithContact(query: string): Promise<{ id: string; name: string; shuttleIqId: string | null; level: string; skillScore: number; email?: string; phone?: string }[]>;
  createPlayer(player: InsertPlayer): Promise<Player>;
  updatePlayer(id: string, updates: Partial<Player>): Promise<Player | undefined>;
  deletePlayer(id: string): Promise<boolean>;
  getPlayerStats(playerId: string): Promise<PlayerStats | null>;

  // Atomic signup: create marketplace user + linked player record in one tx
  signupMarketplaceUserWithPlayer(args: {
    userInsert: InsertMarketplaceUser;
    playerInsert: Omit<InsertPlayer, 'shuttleIqId' | 'referralCode'>;
  }): Promise<{ user: MarketplaceUser; player: Player }>;

  // Atomic profile-completion: for an EXISTING marketplace user (typically a
  // Google sign-up landing without a player record), create a linked player
  // and patch the user's linkedPlayerId — same SIQ-collision retry semantics
  // as signupMarketplaceUserWithPlayer.
  // Throws Error('USER_NOT_FOUND') or Error('PROFILE_ALREADY_COMPLETE') for
  // the obvious bad-state cases so callers can map them to HTTP responses.
  createPlayerForExistingMarketplaceUser(args: {
    userId: string;
    playerInsert: Omit<InsertPlayer, 'shuttleIqId' | 'referralCode'>;
  }): Promise<{ user: MarketplaceUser; player: Player }>;

  // Atomic self-check-in: mark booking attended + idempotently append to queue
  checkInBookingTransaction(args: {
    bookingId: string;
    linkedSessionId: string;
    playerId: string | null;
  }): Promise<{ booking: Booking; queuePosition: number | null; alreadyAttended: boolean }>;
  
  // Court operations (session-specific)
  getCourt(id: string): Promise<Court | undefined>;
  getCourtsBySession(sessionId: string): Promise<Court[]>;
  createCourt(court: InsertCourt): Promise<Court>;
  updateCourt(id: string, updates: Partial<Court>): Promise<Court | undefined>;
  deleteCourt(id: string): Promise<boolean>;
  
  // Court players (many-to-many with team assignments)
  getCourtPlayers(courtId: string): Promise<string[]>;
  getCourtPlayersWithTeams(courtId: string): Promise<CourtPlayer[]>;
  setCourtPlayers(courtId: string, playerIds: string[]): Promise<void>;
  setCourtPlayersWithTeams(courtId: string, assignments: { playerId: string; team: number }[]): Promise<void>;
  
  // Queue operations (session-specific)
  getQueue(sessionId: string): Promise<string[]>;
  setQueue(sessionId: string, playerIds: string[]): Promise<void>;
  addToQueue(sessionId: string, playerId: string): Promise<void>;
  removeFromQueue(sessionId: string, playerId: string): Promise<void>;
  
  // Complex queries
  getCourtsWithPlayers(sessionId: string): Promise<CourtWithPlayers[]>;
  getSessionGameHistory(sessionId: string): Promise<any[]>;
  getSessionGameParticipants(sessionId: string): Promise<(GameParticipant & { createdAt: Date })[]>;

  // Marketplace User operations
  createMarketplaceUser(user: InsertMarketplaceUser): Promise<MarketplaceUser>;
  getMarketplaceUser(id: string): Promise<MarketplaceUser | undefined>;
  getMarketplaceUserByEmail(email: string): Promise<MarketplaceUser | undefined>;
  getMarketplaceUserByResetToken(token: string): Promise<MarketplaceUser | undefined>;
  getMarketplaceUserByVerificationToken(token: string): Promise<MarketplaceUser | undefined>;
  backfillEmailVerifiedForGoogleUsers(): Promise<number>;
  getMarketplaceUserByLinkedPlayerId(playerId: string): Promise<MarketplaceUser | undefined>;
  getMarketplaceUsersByLinkedPlayerIds(playerIds: string[]): Promise<MarketplaceUser[]>;
  getPlayersByIds(ids: string[]): Promise<Player[]>;
  // Player-link OTP (proof of player-profile ownership)
  createPlayerLinkOtp(input: { marketplaceUserId: string; playerId: string; channel: string; destination: string; codeHash: string; expiresAt: Date }): Promise<PlayerLinkOtp>;
  getLatestActivePlayerLinkOtp(marketplaceUserId: string, playerId: string): Promise<PlayerLinkOtp | undefined>;
  countPlayerLinkOtpsForUserSince(marketplaceUserId: string, since: Date): Promise<number>;
  countPlayerLinkOtpsForPairSince(marketplaceUserId: string, playerId: string, since: Date): Promise<number>;
  incrementPlayerLinkOtpAttempts(otpId: string): Promise<PlayerLinkOtp | undefined>;
  consumePlayerLinkOtp(otpId: string): Promise<void>;
  // Player contact-info change requests (verify new email/phone before replacing)
  createPlayerContactChangeRequest(input: { marketplaceUserId: string; playerId: string; field: 'email' | 'phone'; oldValue: string | null; newValue: string; codeHash: string; expiresAt: Date }): Promise<PlayerContactChangeRequest>;
  getLatestActivePlayerContactChangeRequest(marketplaceUserId: string, playerId: string): Promise<PlayerContactChangeRequest | undefined>;
  countPlayerContactChangeRequestsForUserSince(marketplaceUserId: string, since: Date): Promise<number>;
  incrementPlayerContactChangeAttempts(requestId: string): Promise<PlayerContactChangeRequest | undefined>;
  consumePlayerContactChangeRequest(requestId: string, status: 'verified' | 'cancelled'): Promise<void>;
  // Marketplace-account contact-info change requests (verify new email/phone before replacing)
  createMarketplaceUserContactChange(input: { marketplaceUserId: string; field: 'email' | 'phone'; oldValue: string | null; newValue: string; codeHash: string; expiresAt: Date }): Promise<MarketplaceUserContactChange>;
  getLatestActiveMarketplaceUserContactChange(marketplaceUserId: string): Promise<MarketplaceUserContactChange | undefined>;
  countMarketplaceUserContactChangesForUserSince(marketplaceUserId: string, since: Date): Promise<number>;
  incrementMarketplaceUserContactChangeAttempts(requestId: string): Promise<MarketplaceUserContactChange | undefined>;
  consumeMarketplaceUserContactChange(requestId: string, status: 'verified' | 'cancelled'): Promise<void>;
  getMarketplaceUserByGoogleId(googleId: string): Promise<MarketplaceUser | undefined>;
  searchMarketplaceUsersByName(query: string): Promise<MarketplaceUser[]>;
  updateMarketplaceUser(id: string, updates: Partial<MarketplaceUser>): Promise<MarketplaceUser | undefined>;
  updateMarketplaceUserPhoto(id: string, photoUrl: string | null): Promise<MarketplaceUser | undefined>;
  linkPlayerIfUnclaimed(userId: string, playerId: string): Promise<MarketplaceUser | undefined>;
  getAllMarketplaceUsers(): Promise<MarketplaceUser[]>;
  createMarketplaceAuthSession(userId: string, refreshToken: string, expiresAt: Date): Promise<void>;
  findMarketplaceAuthSession(refreshToken: string): Promise<{ id: string; userId: string; refreshToken: string; expiresAt: Date } | undefined>;
  deleteMarketplaceAuthSession(id: string): Promise<void>;

  // Payment resume tokens (post-Ziina-redirect session re-establishment)
  createPaymentResumeToken(input: { marketplaceUserId: string; bookingId: string; tokenHash: string; expiresAt: Date }): Promise<PaymentResumeToken>;
  consumePaymentResumeToken(tokenHash: string): Promise<{ status: 'ok'; token: PaymentResumeToken } | { status: 'unknown' | 'expired' | 'used' }>;
  deleteExpiredPaymentResumeTokens(): Promise<number>;

  // Bookable Session operations
  createBookableSession(session: InsertBookableSession): Promise<BookableSession>;
  getBookableSession(id: string): Promise<BookableSession | undefined>;
  getBookableSessionByLinkedSessionId(linkedSessionId: string): Promise<BookableSession | undefined>;
  getBookableSessionWithAvailability(id: string): Promise<BookableSessionWithAvailability | undefined>;
  getAllBookableSessions(): Promise<BookableSessionWithAvailability[]>;
  getUpcomingBookableSessions(): Promise<BookableSessionWithAvailability[]>;
  updateBookableSession(id: string, updates: Partial<BookableSession>): Promise<BookableSession | undefined>;
  deleteBookableSession(id: string): Promise<boolean>;

  // Booking operations
  createBooking(booking: InsertBooking): Promise<Booking>;
  getBooking(id: string): Promise<Booking | undefined>;
  getBookingByZiinaPaymentIntentId(intentId: string): Promise<Booking | undefined>;
  getBookingWithDetails(id: string): Promise<BookingWithDetails | undefined>;
  getUserBookings(userId: string): Promise<BookingWithDetails[]>;
  getUserBookingForSession(userId: string, sessionId: string): Promise<Booking | undefined>;
  getSessionBookings(sessionId: string): Promise<BookingWithDetails[]>;
  updateBooking(id: string, updates: Partial<Booking>): Promise<Booking | undefined>;
  getBookingCountForSession(sessionId: string): Promise<number>;
  getWaitlistedBookingsForSession(sessionId: string): Promise<Booking[]>;
  getWaitlistCountForSession(sessionId: string): Promise<number>;
  getBookingsNeedingReminder(): Promise<BookingWithDetails[]>;
  getExpiredPendingPaymentBookings(olderThanMs: number): Promise<Booking[]>;

  // Notification operations
  createMarketplaceNotification(data: { userId: string; type: string; title: string; message: string; relatedBookingId?: string }): Promise<MarketplaceNotification>;
  getNotificationsForUser(userId: string): Promise<MarketplaceNotification[]>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(userId: string): Promise<void>;
  getRefundNotifications(): Promise<RefundNotificationWithDetails[]>;
  resolveRefundNotification(id: string): Promise<boolean>;

  // Booking Guest operations
  createBookingGuest(guest: InsertBookingGuest): Promise<BookingGuest>;
  getBookingGuests(bookingId: string): Promise<import("@shared/schema").BookingGuestWithLinked[]>;
  getBookingGuestByToken(token: string): Promise<BookingGuest | undefined>;
  getBookingGuestByPendingPaymentIntentId(intentId: string): Promise<BookingGuest | undefined>;
  deleteBookingGuest(id: string): Promise<void>;
  updateBookingGuest(id: string, updates: Partial<BookingGuest>): Promise<BookingGuest | undefined>;
  getActiveGuestCountForSession(sessionId: string): Promise<number>;
  linkGuestsByEmail(email: string, userId: string): Promise<void>;
  getGuestBookingsForUser(userId: string): Promise<BookingWithDetails[]>;

  // Payment operations
  createPayment(payment: InsertPayment): Promise<Payment>;
  getPayment(id: string): Promise<Payment | undefined>;
  getPaymentByBookingId(bookingId: string): Promise<Payment | undefined>;
  getPaymentsByBookingId(bookingId: string): Promise<Payment[]>;
  updatePayment(id: string, updates: Partial<Payment>): Promise<Payment | undefined>;

  // Score dispute operations
  createScoreDispute(data: { gameResultId: string; filedByUserId: string; note?: string }): Promise<ScoreDispute>;
  createScoreDisputeAtomic(data: { gameResultId: string; filedByUserId: string; note?: string }): Promise<{ dispute: ScoreDispute; isFirstForGame: boolean; alreadyFlagged: boolean }>;
  getScoreDispute(id: string): Promise<ScoreDispute | undefined>;
  getDisputeByUserAndGame(userId: string, gameResultId: string): Promise<ScoreDispute | undefined>;
  hasAnyDisputeForGame(gameResultId: string): Promise<boolean>;
  getAllDisputesWithDetails(): Promise<ScoreDisputeWithDetails[]>;
  getDisputesByUser(userId: string): Promise<ScoreDispute[]>;
  updateScoreDispute(id: string, updates: Partial<ScoreDispute>): Promise<ScoreDispute | undefined>;

  // Game result + participant lookups (used by score-flag endpoint to verify
  // the flagger actually played in the game).
  getGameResult(id: string): Promise<GameResult | undefined>;
  getGameParticipants(gameId: string): Promise<GameParticipant[]>;

  // Marketplace admin recipients for system notifications (e.g. score flags).
  // Returns marketplace_users with role 'admin' or 'super_admin'. Used to
  // fan-out a single in-app notification per admin.
  listMarketplaceAdmins(): Promise<MarketplaceUser[]>;

  // Court Captain panel: pending suggestions for a session, eagerly joined
  // with court name + lineup so the panel renders in one query.
  listSessionPendingSuggestionsWithDetails(sessionId: string): Promise<Array<MatchSuggestion & {
    courtName: string;
    players: Array<MatchSuggestionPlayer & { name: string }>;
  }>>;
  getLineupSwapCandidates(sessionId: string, suggestionId: string): Promise<{
    candidates: Array<{ playerId: string; name: string }>;
    playingPlayerIds: string[];
  }>;
  swapMatchSuggestionPlayers(
    sessionId: string,
    suggestionId: string,
    swaps: Array<{ removePlayerId: string; addPlayerId: string; team: number }>,
  ): Promise<(MatchSuggestion & {
    courtName: string;
    players: Array<MatchSuggestionPlayer & { name: string }>;
  })>;

  // Player personality tag operations
  getAllTags(): Promise<Tag[]>;
  getTrendingTags(limit?: number): Promise<TrendingTag[]>;
  getPlayerTopTags(playerId: string, limit?: number): Promise<PlayerTopTag[]>;
  getPlayersWithTag(tagId: string, limit?: number): Promise<Array<{ player: Player; count: number }>>;
  createPlayerTags(entries: InsertPlayerTag[]): Promise<PlayerTag[]>;
  getPlayerTagsForGame(gameResultId: string, taggedByPlayerId: string): Promise<PlayerTag[]>;
  getTaggedGameIds(taggedByPlayerId: string): Promise<string[]>;
  getGameParticipantInfo(gameResultId: string): Promise<GameParticipantInfo[]>;
  getAllPlayersTopTag(): Promise<PlayerTopTagEntry[]>;
  getCommunitySpotlight(limit?: number): Promise<CommunitySpotlightEntry[]>;
  getRecentReceivedTags(taggedPlayerId: string, limit?: number): Promise<ReceivedTagEntry[]>;
  getTagCountsForTargets(targetPlayerIds: string[], tagIds: string[]): Promise<TagCountResult[]>;

  // Tag suggestions
  createTagSuggestion(data: InsertTagSuggestion): Promise<TagSuggestion>;
  getTagSuggestions(status: 'pending' | 'approved' | 'rejected', viewerPlayerId?: string): Promise<TagSuggestionWithVote[]>;
  getTagSuggestionsByPlayer(playerId: string): Promise<TagSuggestion[]>;
  voteTagSuggestion(suggestionId: string, playerId: string): Promise<{ alreadyVoted: boolean; ownSuggestion: boolean; notPending: boolean; newCount: number }>;
  unvoteTagSuggestion(suggestionId: string, playerId: string): Promise<{ newCount: number }>;
  reviewTagSuggestion(suggestionId: string, status: 'approved' | 'rejected', adminNote?: string): Promise<TagSuggestion | undefined>;

  // Public analytics
  getPublicAnalytics(options: { sessionId?: string; from?: Date; to?: Date }): Promise<PublicAnalyticsResponse>;

  // Finance / Accounting
  getAllExpenseCategories(): Promise<ExpenseCategory[]>;
  createExpenseCategory(data: InsertExpenseCategory): Promise<ExpenseCategory>;
  updateExpenseCategory(id: string, updates: Partial<ExpenseCategory>): Promise<ExpenseCategory | undefined>;
  deleteExpenseCategory(id: string): Promise<void>;

  createExpense(data: InsertExpense): Promise<Expense>;
  getExpense(id: string): Promise<Expense | undefined>;
  getAllExpenses(filters?: { from?: Date; to?: Date; categoryId?: string; paidBy?: string }): Promise<ExpenseWithCategory[]>;
  updateExpense(id: string, updates: Partial<Pick<Expense, 'categoryId' | 'amountAed' | 'description' | 'vendor' | 'paidBy' | 'date' | 'notes'>>): Promise<Expense | undefined>;
  deleteExpense(id: string): Promise<void>;

  getFinanceSummary(from: Date, to: Date): Promise<FinanceSummary>;

  // Blog operations
  createBlogPost(data: InsertBlogPost): Promise<BlogPost>;
  getBlogPost(id: string): Promise<BlogPost | undefined>;
  getBlogPostBySlug(slug: string): Promise<BlogPost | undefined>;
  getAllBlogPosts(includeUnpublished?: boolean): Promise<BlogPost[]>;
  updateBlogPost(id: string, updates: Partial<BlogPost>): Promise<BlogPost | undefined>;
  deleteBlogPost(id: string): Promise<boolean>;

  // Referral operations
  createReferral(data: InsertReferral): Promise<Referral>;
  getReferral(id: string): Promise<Referral | undefined>;
  getReferralByRefereeUserId(refereeUserId: string): Promise<Referral | undefined>;
  getReferralByRefereePlayerId(refereePlayerId: string): Promise<Referral | undefined>;
  getReferralsByReferrerId(referrerId: string): Promise<(Referral & { refereeName: string | null })[]>;
  getCompletedReferralCount(referrerId: string): Promise<number>;
  getAllReferrals(): Promise<(Referral & { referrerName: string; refereeEmail: string; referralCode: string | null; ambassadorStatus: boolean; jerseyDispatched: boolean })[]>;
  updateReferral(id: string, updates: Partial<Referral>): Promise<Referral | undefined>;
  getReferralLeaderboard(limit?: number): Promise<{ playerId: string; playerName: string; referralCode: string | null; completedCount: number; ambassadorStatus: boolean; photoUrl: string | null }[]>;
  getPlayerByReferralCode(code: string): Promise<Player | undefined>;
  backfillReferralCodes(): Promise<number>;

  // Match suggestion operations (Phase 1 of player-facing gameplay flow)
  // `status` defaults to 'pending'. Pass 'queued' for "next round" lineups
  // built for an occupied court — those rows have pendingUntil = null and
  // are flipped to 'pending' (with a fresh 90s window) when the current
  // game on that court ends.
  // `includesActivePlayers` is meaningful only for 'queued' rows (Case 2 of
  // the queued orchestrator); it tells the game-end transition to verify
  // availability of the 4 named players before flipping the row.
  createMatchSuggestion(input: {
    sessionId: string;
    courtId: string;
    pendingUntil: Date | null;
    status?: 'pending' | 'queued';
    includesActivePlayers?: boolean;
    players: Array<{ playerId: string; team: number }>;
  }): Promise<MatchSuggestion>;
  getMatchSuggestion(id: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined>;
  // Returns the most recent pending-or-approved suggestion for a court,
  // INCLUDING its 4 player rows. ('pending' = awaiting approval; 'approved'
  // = approved but not yet started; both states are "active" from the
  // court's perspective.)
  getPendingMatchSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined>;
  // Like getPendingMatchSuggestionForCourt, but ALSO includes 'playing'
  // status. Used by the admin court endpoints (cancel-game, end-game) to
  // locate the live suggestion that needs to be transitioned out of the
  // active set when an admin acts on the court directly.
  getActiveMatchSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined>;
  // Admin-driven assignment: dismisses any existing pending|approved|
  // playing suggestion for this court OR involving any of these players,
  // then inserts a new 'playing' suggestion + 4 child rows. All in one
  // transaction so the player-facing /current-suggestion view never
  // observes a half-applied state. Returns the new suggestion row.
  replaceActiveSuggestionForAdminAssignment(input: {
    sessionId: string;
    courtId: string;
    pendingUntil: Date;
    approvedBy: string;
    players: Array<{ playerId: string; team: number }>;
  }): Promise<MatchSuggestion>;
  // Singular: a player should be in at most one pending-or-approved
  // suggestion at a time (enforced by the createMatchSuggestion path). The
  // 4-row lineup on match_suggestion_players is preserved across the
  // suggestion's lifetime (pending → approved → playing → completed) so
  // historical lookups stay intact; the duplicated courtId on
  // match_suggestion_players is for hot-path court-side queries that don't
  // need parent state. To check active status we still join the parent.
  // Returns the suggestion AND its 4 player rows.
  getCurrentSuggestionForPlayer(playerId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined>;
  listPastPendingMatchSuggestions(now: Date): Promise<MatchSuggestion[]>;
  updateMatchSuggestionStatus(id: string, status: string, approvedBy?: string | null): Promise<MatchSuggestion | undefined>;
  transitionPendingMatchSuggestion(id: string, nextStatus: string, approvedBy?: string | null): Promise<MatchSuggestion | undefined>;
  // Queued-suggestion lifecycle helpers — see implementations for details.
  getQueuedSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined>;
  flipQueuedSuggestionToPending(suggestionId: string, pendingUntil: Date): Promise<MatchSuggestion | undefined>;
  dismissQueuedSuggestion(suggestionId: string): Promise<MatchSuggestion | undefined>;
  // Player-driven start-game transition. Atomic compare-and-set from
  // 'approved' → 'playing'. Returns:
  //   - { result: 'started', suggestion }      — caller won the race; must apply side effects
  //   - { result: 'already-started', suggestion } — another caller already flipped it; idempotent success, no side effects
  //   - { result: 'not-startable', suggestion } — row exists but is in a non-startable state (dismissed/completed/pending)
  //   - { result: 'not-found' }                 — no such row
  // Concurrent callers are mutually exclusive: at most one observes 'started'.
  startApprovedSuggestion(suggestionId: string): Promise<
    | { result: 'started'; suggestion: MatchSuggestion }
    | { result: 'already-started'; suggestion: MatchSuggestion }
    | { result: 'not-startable'; suggestion: MatchSuggestion }
    | { result: 'not-found' }
  >;

  // Transactional game completion — wraps player updates + game_results +
  // game_participants (and optional match_suggestion completion) in a single
  // db.transaction so partial writes can never leave skill scores corrupted.
  completeGameTransaction(args: {
    sessionId: string;
    courtId: string;
    team1Score: number;
    team2Score: number;
    winningTeam: number;
    matchSuggestionId?: string | null;
    isSandboxSession: boolean;
    playerIds: string[];
    computePerPlayer: (freshPlayers: Player[]) => Array<{
      playerId: string;
      team: number;
      skillBefore: number;
      skillAfter: number;
      playerUpdates: Partial<Player>;
    }>;
  }): Promise<{
    gameId: string;
    participants: Array<{ playerId: string; team: number; skillBefore: number; skillAfter: number }>;
    alreadySubmitted: boolean;
  }>;
}

export class DatabaseStorage implements IStorage {
  // Session operations
  async createSession(insertSession: InsertSession): Promise<Session> {
    // Allow multiple concurrent sessions (removed auto-ending logic)
    // Default to 'active' status to preserve existing workflow
    const id = randomUUID();
    const status = insertSession.status || 'active';
    
    // Set endedAt timestamp if creating an ended session
    const endedAt = status === 'ended' ? new Date() : undefined;
    
    const [session] = await db
      .insert(sessions)
      .values({ 
        ...insertSession,
        ...(endedAt && { endedAt }),
        id,
        status
      })
      .returning();
    
    // Create courts for the new session
    const courtsToCreate = insertSession.courtCount || 2;
    for (let i = 1; i <= courtsToCreate; i++) {
      await this.createCourt({
        name: `Court ${i}`,
        sessionId: session.id,
        status: 'available',
        timeRemaining: 0,
        winningTeam: null,
        startedAt: null
      });
    }

    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
    return session || undefined;
  }

  async getActiveSession(): Promise<Session | undefined> {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.status, 'active'))
      .orderBy(desc(sessions.createdAt))
      .limit(1);
    return session || undefined;
  }

  async getAllSessions(includeSandbox = false): Promise<Session[]> {
    if (includeSandbox) {
      return await db.select().from(sessions).where(eq(sessions.isSandbox, true)).orderBy(desc(sessions.createdAt));
    }
    return await db.select().from(sessions).where(eq(sessions.isSandbox, false)).orderBy(desc(sessions.createdAt));
  }

  async endSession(id: string): Promise<Session | undefined> {
    // Sweep any in-flight match suggestions for this session to 'dismissed'
    // BEFORE flipping the session to 'ended'. Without this, a never-resolved
    // pending/approved/playing/queued row would keep being returned by
    // /current-suggestion the next time those same players join a new
    // session — see getCurrentSuggestionForPlayer's session-active filter,
    // which would still surface the row if the source session were left
    // 'active'. Doing the sweep here gives us belt-and-braces: even if a
    // future caller forgets the session-active filter, the rows themselves
    // are no longer in an active state.
    //
    // Also free any 'playing' courts for this session so the admin court
    // grid doesn't show ghost games after the session has ended.
    const inFlightCourtIds = await db
      .select({ courtId: matchSuggestions.courtId })
      .from(matchSuggestions)
      .where(and(
        eq(matchSuggestions.sessionId, id),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
      ));

    await db
      .update(matchSuggestions)
      .set({ status: 'dismissed' })
      .where(and(
        eq(matchSuggestions.sessionId, id),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
      ));

    if (inFlightCourtIds.length > 0) {
      const uniqueCourtIds = Array.from(new Set(inFlightCourtIds.map(r => r.courtId)));
      await db
        .update(courts)
        .set({ status: 'available' })
        .where(and(
          inArray(courts.id, uniqueCourtIds),
          eq(courts.status, 'playing'),
        ));
    }

    const [session] = await db
      .update(sessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(sessions.id, id))
      .returning();
    return session || undefined;
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<Session | undefined> {
    const [session] = await db
      .update(sessions)
      .set(updates)
      .where(eq(sessions.id, id))
      .returning();
    return session || undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    // Clear matchmaking rest states for this session
    clearSessionRestStates(id);
    
    // Delete all related data first (cascade delete)
    // Get all courts for this session FIRST before any deletions
    const sessionCourts = await this.getCourtsBySession(id);
    
    // Collect all game IDs before deleting anything
    const allGameIds: string[] = [];
    for (const court of sessionCourts) {
      const courtGames = await db
        .select()
        .from(gameResults)
        .where(eq(gameResults.courtId, court.id));
      allGameIds.push(...courtGames.map(g => g.id));
    }
    
    // 1. Delete game participants for all collected games
    if (allGameIds.length > 0) {
      await db.delete(gameParticipants).where(inArray(gameParticipants.gameId, allGameIds));
    }
    
    // 2. Delete game results for all courts in this session
    for (const court of sessionCourts) {
      await db.delete(gameResults).where(eq(gameResults.courtId, court.id));
    }
    
    // 3. Delete court players for all courts in this session
    for (const court of sessionCourts) {
      await db.delete(courtPlayersTable).where(eq(courtPlayersTable.courtId, court.id));
    }
    
    // 4. Delete courts
    await db.delete(courts).where(eq(courts.sessionId, id));
    
    // 5. Delete queue entries
    await db.delete(queueEntries).where(eq(queueEntries.sessionId, id));
    
    // 6. Delete linked bookable sessions and their bookings/payments/guests
    const linkedBookableSessions = await db.select().from(bookableSessions).where(eq(bookableSessions.linkedSessionId, id));
    for (const bs of linkedBookableSessions) {
      const linkedBookings = await db.select().from(bookings).where(eq(bookings.sessionId, bs.id));
      for (const booking of linkedBookings) {
        // booking_guests has FK on booking_id — must delete before bookings
        await db.delete(bookingGuests).where(eq(bookingGuests.bookingId, booking.id));
        await db.delete(payments).where(eq(payments.bookingId, booking.id));
      }
      await db.delete(bookings).where(eq(bookings.sessionId, bs.id));
      await db.delete(bookableSessions).where(eq(bookableSessions.id, bs.id));
    }
    
    // 7. Finally delete the session
    const result = await db.delete(sessions).where(eq(sessions.id, id));
    return result.rowCount ? result.rowCount > 0 : false;
  }

  // Player operations
  async getPlayer(id: string): Promise<Player | undefined> {
    const [player] = await db.select().from(players).where(eq(players.id, id));
    return player ? addSkidToPlayer(player) : undefined;
  }

  // Batched lookups used by the auto-approve sweep to avoid N+1 round-trips
  // when notifying the 4 players assigned to an approved court.
  async getPlayersByIds(ids: string[]): Promise<Player[]> {
    if (ids.length === 0) return [];
    const rows = await db.select().from(players).where(inArray(players.id, ids));
    return rows.map(addSkidToPlayer);
  }

  async getMarketplaceUsersByLinkedPlayerIds(playerIds: string[]): Promise<MarketplaceUser[]> {
    if (playerIds.length === 0) return [];
    return await db.select().from(marketplaceUsers).where(inArray(marketplaceUsers.linkedPlayerId, playerIds));
  }

  async getPlayerByExternalId(externalId: string): Promise<Player | undefined> {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.externalId, externalId));
    return player ? addSkidToPlayer(player) : undefined;
  }

  async getPlayerByShuttleIqId(shuttleIqId: string): Promise<Player | undefined> {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.shuttleIqId, shuttleIqId));
    return player ? addSkidToPlayer(player) : undefined;
  }

  async getAllPlayers(): Promise<Player[]> {
    const playerList = await db.select().from(players).orderBy(asc(players.name));
    return playerList.map(addSkidToPlayer);
  }

  async searchPlayers(query: string): Promise<Player[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    const upperQuery = `%${query.toUpperCase()}%`;
    const playerList = await db
      .select()
      .from(players)
      .where(sql`LOWER(${players.name}) LIKE ${lowerQuery} OR ${players.shuttleIqId} LIKE ${upperQuery} OR LOWER(${players.email}) LIKE ${lowerQuery} OR LOWER(${players.phone}) LIKE ${lowerQuery}`)
      .orderBy(asc(players.name));

    return playerList.map(addSkidToPlayer);
  }

  async searchPlayersWithContact(query: string): Promise<{ id: string; name: string; shuttleIqId: string | null; level: string; skillScore: number; email?: string; phone?: string }[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    const upperQuery = `%${query.toUpperCase()}%`;

    const playerList = await db
      .select()
      .from(players)
      .where(sql`LOWER(${players.name}) LIKE ${lowerQuery} OR ${players.shuttleIqId} LIKE ${upperQuery} OR LOWER(${players.email}) LIKE ${lowerQuery} OR LOWER(${players.phone}) LIKE ${lowerQuery}`)
      .orderBy(asc(players.name));

    return playerList.map(p => ({
      id: p.id,
      name: p.name,
      shuttleIqId: p.shuttleIqId,
      level: p.level,
      skillScore: p.skillScore,
      email: p.email || undefined,
      phone: p.phone || undefined,
    }));
  }

  async createPlayer(insertPlayer: InsertPlayer): Promise<Player> {
    const id = randomUUID();
    const shuttleIqId = await generateShuttleIqId();
    const referralCode = generateReferralCode(insertPlayer.name, shuttleIqId);
    const [player] = await db
      .insert(players)
      .values({ 
        ...insertPlayer, 
        id,
        shuttleIqId,
        referralCode,
        status: insertPlayer.status || 'waiting',
        gamesPlayed: insertPlayer.gamesPlayed || 0,
        wins: insertPlayer.wins || 0,
        skillScoreBaseline: insertPlayer.skillScore ?? 50,
      })
      .returning();
    return addSkidToPlayer(player);
  }

  // Wraps an operation that allocates a fresh SIQ id + referral code in the
  // unique-constraint retry loop. Two concurrent allocations landing in the
  // same millisecond can both pick the same next SIQ-XXXXX id (it's computed
  // by reading the current MAX outside the tx). On the rare collision we
  // retry up to 3 times before propagating the error.
  private async _withSiqRetry<T>(
    playerName: string,
    fn: (shuttleIqId: string, referralCode: string) => Promise<T>,
  ): Promise<T> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const shuttleIqId = await generateShuttleIqId();
      const referralCode = generateReferralCode(playerName, shuttleIqId);
      try {
        return await fn(shuttleIqId, referralCode);
      } catch (err: any) {
        const code = err?.code ?? err?.cause?.code;
        const msg = String(err?.message ?? '');
        const isSiqRace =
          code === '23505' &&
          (msg.includes('shuttle_iq_id') || msg.includes('referral_code'));
        if (!isSiqRace || attempt === MAX_ATTEMPTS - 1) throw err;
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('Player allocation failed after retries');
  }

  // Shared helper: insert a single player row inside the given transaction,
  // applying the same defaults used by both signup paths. Returning the raw
  // (non-skid-decorated) player so callers can compose further; decorate at
  // the call site with addSkidToPlayer.
  private async _insertPlayerInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    playerInsert: Omit<InsertPlayer, 'shuttleIqId' | 'referralCode'>,
    shuttleIqId: string,
    referralCode: string,
  ): Promise<Player> {
    const playerId = randomUUID();
    const [createdPlayer] = await tx
      .insert(players)
      .values({
        ...playerInsert,
        id: playerId,
        shuttleIqId,
        referralCode,
        status: playerInsert.status || 'waiting',
        gamesPlayed: playerInsert.gamesPlayed || 0,
        wins: playerInsert.wins || 0,
        skillScoreBaseline: playerInsert.skillScore ?? 50,
      })
      .returning();
    return createdPlayer;
  }

  async signupMarketplaceUserWithPlayer(args: {
    userInsert: InsertMarketplaceUser;
    playerInsert: Omit<InsertPlayer, 'shuttleIqId' | 'referralCode'>;
  }): Promise<{ user: MarketplaceUser; player: Player }> {
    return this._withSiqRetry(args.playerInsert.name, (shuttleIqId, referralCode) =>
      db.transaction(async (tx) => {
        const userId = randomUUID();
        const [createdUser] = await tx
          .insert(marketplaceUsers)
          .values({ ...args.userInsert, id: userId, linkedPlayerId: null })
          .returning();

        const createdPlayer = await this._insertPlayerInTx(
          tx,
          args.playerInsert,
          shuttleIqId,
          referralCode,
        );

        const [linkedUser] = await tx
          .update(marketplaceUsers)
          .set({ linkedPlayerId: createdPlayer.id })
          .where(eq(marketplaceUsers.id, createdUser.id))
          .returning();

        return { user: linkedUser, player: addSkidToPlayer(createdPlayer) };
      }),
    );
  }

  async createPlayerForExistingMarketplaceUser(args: {
    userId: string;
    playerInsert: Omit<InsertPlayer, 'shuttleIqId' | 'referralCode'>;
  }): Promise<{ user: MarketplaceUser; player: Player }> {
    return this._withSiqRetry(args.playerInsert.name, (shuttleIqId, referralCode) =>
      db.transaction(async (tx) => {
        // Race-safe: insert player first (rolled back automatically on any
        // throw below), then claim the user via a conditional UPDATE that
        // only matches when linked_player_id is still null. Two concurrent
        // complete-profile requests for the same user will serialize on the
        // row lock; the loser sees 0 affected rows and we throw to roll
        // back its just-inserted (orphan) player.
        const createdPlayer = await this._insertPlayerInTx(
          tx,
          args.playerInsert,
          shuttleIqId,
          referralCode,
        );

        const updated = await tx
          .update(marketplaceUsers)
          .set({ linkedPlayerId: createdPlayer.id })
          .where(
            and(
              eq(marketplaceUsers.id, args.userId),
              isNull(marketplaceUsers.linkedPlayerId),
            ),
          )
          .returning();

        if (updated.length === 0) {
          // Disambiguate USER_NOT_FOUND vs PROFILE_ALREADY_COMPLETE for the
          // route layer's status mapping. Either branch throws to abort the
          // tx (and roll back the orphan player insert above).
          const [existing] = await tx
            .select()
            .from(marketplaceUsers)
            .where(eq(marketplaceUsers.id, args.userId));
          if (!existing) throw new Error('USER_NOT_FOUND');
          throw new Error('PROFILE_ALREADY_COMPLETE');
        }

        return { user: updated[0], player: addSkidToPlayer(createdPlayer) };
      }),
    );
  }

  async checkInBookingTransaction(args: {
    bookingId: string;
    linkedSessionId: string;
    playerId: string | null;
  }): Promise<{ booking: Booking; queuePosition: number | null; alreadyAttended: boolean }> {
    return await db.transaction(async (tx) => {
      // Serialize all queue mutations for this internal session so two
      // concurrent self-check-ins (or a self check-in racing the admin
      // path) can't both compute the same MAX(position)+1. We use a
      // transaction-scoped advisory lock keyed on the session id; it is
      // released automatically at COMMIT/ROLLBACK and doesn't touch any
      // table rows that other unrelated queries care about.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.linkedSessionId}, 0))`,
      );

      // Lock the booking row too — protects against two concurrent
      // check-ins on the same booking flipping it twice.
      const [current] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, args.bookingId))
        .for('update');

      if (!current) {
        throw new Error('BOOKING_NOT_FOUND');
      }

      // Re-validate booking eligibility inside the tx. Only confirmed or
      // already-attended bookings may proceed; anything else (pending
      // payment, waitlisted, cancelled) is rejected. The endpoint also
      // checks this before entering the tx, but the lock-then-recheck
      // pattern protects against a status change between the two reads.
      if (current.status !== 'confirmed' && current.status !== 'attended') {
        throw new Error('BOOKING_NOT_ELIGIBLE');
      }

      const alreadyAttended = current.status === 'attended';
      let booking: Booking;

      if (alreadyAttended) {
        booking = current;
      } else {
        const [updated] = await tx
          .update(bookings)
          .set({ status: 'attended', attendedAt: new Date() })
          .where(eq(bookings.id, args.bookingId))
          .returning();
        booking = updated;
      }

      // No linked player → skip queue entirely. Caller will surface a
      // "ask the Court Captain to add you to the queue" message.
      if (!args.playerId) {
        return { booking, queuePosition: null, alreadyAttended };
      }

      // Idempotent queue insert. Read first, then conditionally insert.
      const existingEntry = await tx
        .select()
        .from(queueEntries)
        .where(and(
          eq(queueEntries.sessionId, args.linkedSessionId),
          eq(queueEntries.playerId, args.playerId),
        ))
        .limit(1);

      if (existingEntry.length > 0) {
        return { booking, queuePosition: existingEntry[0].position, alreadyAttended };
      }

      // Compute next position by scanning the queue inside the tx; the
      // advisory lock above guarantees no other check-in is racing us.
      const maxRow = await tx
        .select({ maxPos: sql<number | null>`MAX(${queueEntries.position})` })
        .from(queueEntries)
        .where(eq(queueEntries.sessionId, args.linkedSessionId));
      const maxPos = maxRow[0]?.maxPos;
      const nextPosition = (typeof maxPos === 'number' && maxPos >= 0) ? maxPos + 1 : 0;

      await tx.insert(queueEntries).values({
        id: randomUUID(),
        sessionId: args.linkedSessionId,
        playerId: args.playerId,
        position: nextPosition,
      });

      return { booking, queuePosition: nextPosition, alreadyAttended };
    });
  }

  async updatePlayer(id: string, updates: Partial<Player>): Promise<Player | undefined> {
    const [updated] = await db
      .update(players)
      .set(updates)
      .where(eq(players.id, id))
      .returning();
    return updated ? addSkidToPlayer(updated) : undefined;
  }

  async deletePlayer(id: string): Promise<boolean> {
    // Delete related court players
    await db.delete(courtPlayersTable).where(eq(courtPlayersTable.playerId, id));
    
    // Delete related queue entries
    await db.delete(queueEntries).where(eq(queueEntries.playerId, id));
    
    // Delete the player
    const result = await db.delete(players).where(eq(players.id, id)).returning();
    return result.length > 0;
  }

  async getPlayerStats(playerId: string): Promise<PlayerStats | null> {
    const player = await this.getPlayer(playerId);
    if (!player) return null;
    const linkedUser = await this.getMarketplaceUserByLinkedPlayerId(playerId);
    const playerPhotoUrl = linkedUser?.photoUrl ?? null;

    // Get all players for ranking calculations
    const allPlayers = await this.getAllPlayers();
    const playersWithGames = allPlayers.filter(p => p.gamesPlayed > 0);
    
    // Calculate rankings
    const sortedBySkill = [...allPlayers].sort((a, b) => b.skillScore - a.skillScore);
    const sortedByWins = [...allPlayers].sort((a, b) => b.wins - a.wins);
    const sortedByWinRate = [...playersWithGames].sort((a, b) => {
      const aRate = a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0;
      const bRate = b.gamesPlayed > 0 ? b.wins / b.gamesPlayed : 0;
      return bRate - aRate;
    });
    
    const rankBySkillScore = sortedBySkill.findIndex(p => p.id === playerId) + 1;
    const rankByWins = sortedByWins.findIndex(p => p.id === playerId) + 1;
    const rankByWinRate = player.gamesPlayed > 0 
      ? sortedByWinRate.findIndex(p => p.id === playerId) + 1 
      : playersWithGames.length + 1;

    // Get all games this player participated in
    const playerGames = await db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.playerId, playerId));
    
    if (playerGames.length === 0) {
      return {
        player,
        playerPhotoUrl,
        winRate: 0,
        totalGames: player.gamesPlayed,
        totalWins: player.wins,
        currentStreak: { type: 'none', count: 0 },
        longestWinStreak: 0,
        longestLossStreak: 0,
        rankBySkillScore,
        rankByWins,
        rankByWinRate,
        totalPlayersRanked: allPlayers.length,
        performanceTrend: 'stable',
        recentWinRate: 0,
        avgScoreDifferential: 0,
        avgPointsFor: 0,
        avgPointsAgainst: 0,
        bestPartner: null,
        frequentPartners: [],
        rivals: [],
        favoriteOpponents: [],
        recentGames: []
      };
    }

    const gameIds = playerGames.map(g => g.gameId);
    
    // Get game results for these games, excluding sandbox session games (ordered by date for streak calculation)
    const games = await db
      .select()
      .from(gameResults)
      .where(sql`${gameResults.id} IN (${sql.join(gameIds.map(id => sql`${id}`), sql`, `)}) AND ${gameResults.sessionId} IN (SELECT id FROM sessions WHERE is_sandbox = false)`)
      .orderBy(desc(gameResults.createdAt));

    // Get all participants for non-sandbox games only
    const nonSandboxGameIds = games.map(g => g.id);
    if (nonSandboxGameIds.length === 0) {
      return {
        player,
        playerPhotoUrl,
        winRate: 0,
        totalGames: player.gamesPlayed,
        totalWins: player.wins,
        currentStreak: { type: 'none', count: 0 },
        longestWinStreak: 0,
        longestLossStreak: 0,
        rankBySkillScore,
        rankByWins,
        rankByWinRate,
        totalPlayersRanked: allPlayers.length,
        performanceTrend: 'stable',
        recentWinRate: 0,
        avgScoreDifferential: 0,
        avgPointsFor: 0,
        avgPointsAgainst: 0,
        bestPartner: null,
        frequentPartners: [],
        rivals: [],
        favoriteOpponents: [],
        recentGames: []
      };
    }
    const allParticipants = await db
      .select()
      .from(gameParticipants)
      .where(inArray(gameParticipants.gameId, nonSandboxGameIds));

    // Get player list for lookups
    const participantPlayerIds = Array.from(new Set(allParticipants.map(p => p.playerId)));
    const playerList = await db
      .select()
      .from(players)
      .where(inArray(players.id, participantPlayerIds));
    const playerMap = new Map(playerList.map(p => [p.id, addSkidToPlayer(p)]));

    // Calculate game outcomes for streak and trend calculations
    const gameOutcomes: { won: boolean; team1Score: number; team2Score: number; playerTeam: number }[] = [];
    
    // Partner and opponent tracking
    const partnerStats: Record<string, { games: number; wins: number }> = {};
    const opponentStats: Record<string, { games: number; wins: number }> = {};
    
    let totalPointsFor = 0;
    let totalPointsAgainst = 0;

    for (const game of games) {
      const gameParticipantsList = allParticipants.filter(p => p.gameId === game.id);
      const playerInGame = gameParticipantsList.find(p => p.playerId === playerId);
      if (!playerInGame) continue;
      
      const playerTeam = playerInGame.team;
      const isWin = game.winningTeam === playerTeam;
      
      // Calculate points for/against
      const pointsFor = playerTeam === 1 ? game.team1Score : game.team2Score;
      const pointsAgainst = playerTeam === 1 ? game.team2Score : game.team1Score;
      totalPointsFor += pointsFor;
      totalPointsAgainst += pointsAgainst;
      
      gameOutcomes.push({ won: isWin, team1Score: game.team1Score, team2Score: game.team2Score, playerTeam });
      
      // Track partner stats
      const partner = gameParticipantsList.find(p => p.team === playerTeam && p.playerId !== playerId);
      if (partner) {
        if (!partnerStats[partner.playerId]) {
          partnerStats[partner.playerId] = { games: 0, wins: 0 };
        }
        partnerStats[partner.playerId].games++;
        if (isWin) partnerStats[partner.playerId].wins++;
      }
      
      // Track opponent stats
      const opponents = gameParticipantsList.filter(p => p.team !== playerTeam);
      for (const opp of opponents) {
        if (!opponentStats[opp.playerId]) {
          opponentStats[opp.playerId] = { games: 0, wins: 0 };
        }
        opponentStats[opp.playerId].games++;
        if (isWin) opponentStats[opp.playerId].wins++;
      }
    }

    // Calculate streaks
    let currentStreak: PlayerStats['currentStreak'] = { type: 'none', count: 0 };
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let tempWinStreak = 0;
    let tempLossStreak = 0;
    
    // Games are in descending order, so reverse for chronological streak calc
    const chronologicalOutcomes = [...gameOutcomes].reverse();
    
    for (const outcome of chronologicalOutcomes) {
      if (outcome.won) {
        tempWinStreak++;
        tempLossStreak = 0;
        if (tempWinStreak > longestWinStreak) longestWinStreak = tempWinStreak;
      } else {
        tempLossStreak++;
        tempWinStreak = 0;
        if (tempLossStreak > longestLossStreak) longestLossStreak = tempLossStreak;
      }
    }
    
    // Current streak (from most recent games)
    if (gameOutcomes.length > 0) {
      const firstOutcome = gameOutcomes[0];
      currentStreak.type = firstOutcome.won ? 'win' : 'loss';
      currentStreak.count = 1;
      for (let i = 1; i < gameOutcomes.length; i++) {
        if (gameOutcomes[i].won === firstOutcome.won) {
          currentStreak.count++;
        } else {
          break;
        }
      }
    }

    // Performance trend (compare last 5 games to overall)
    const recentGamesForTrend = gameOutcomes.slice(0, 5);
    const recentWins = recentGamesForTrend.filter(g => g.won).length;
    const recentWinRate = recentGamesForTrend.length > 0 
      ? Math.round((recentWins / recentGamesForTrend.length) * 100) 
      : 0;
    const overallWinRate = player.gamesPlayed > 0 
      ? Math.round((player.wins / player.gamesPlayed) * 100) 
      : 0;
    
    let performanceTrend: PlayerStats['performanceTrend'] = 'stable';
    if (recentGamesForTrend.length >= 3) {
      if (recentWinRate > overallWinRate + 10) performanceTrend = 'improving';
      else if (recentWinRate < overallWinRate - 10) performanceTrend = 'declining';
    }

    // Score differential
    const avgPointsFor = games.length > 0 ? Math.round(totalPointsFor / games.length * 10) / 10 : 0;
    const avgPointsAgainst = games.length > 0 ? Math.round(totalPointsAgainst / games.length * 10) / 10 : 0;
    const avgScoreDifferential = Math.round((avgPointsFor - avgPointsAgainst) * 10) / 10;

    // Build frequent partners list
    const frequentPartners: PlayerStats['frequentPartners'] = Object.entries(partnerStats)
      .map(([partnerId, stats]) => ({
        player: playerMap.get(partnerId)!,
        gamesTogether: stats.games,
        winsTogether: stats.wins,
        winRate: Math.round((stats.wins / stats.games) * 100)
      }))
      .filter(p => p.player)
      .sort((a, b) => b.gamesTogether - a.gamesTogether)
      .slice(0, 5);

    // Best partner
    let bestPartner: PlayerStats['bestPartner'] = null;
    if (frequentPartners.length > 0) {
      const best = frequentPartners.reduce((best, current) => 
        current.winsTogether > best.winsTogether ? current : best
      );
      bestPartner = { player: best.player, winsTogether: best.winsTogether };
    }

    // Build rivals (most played against)
    const rivals: PlayerStats['rivals'] = Object.entries(opponentStats)
      .map(([oppId, stats]) => ({
        player: playerMap.get(oppId)!,
        gamesAgainst: stats.games,
        winsAgainst: stats.wins,
        lossesAgainst: stats.games - stats.wins,
        winRate: Math.round((stats.wins / stats.games) * 100)
      }))
      .filter(r => r.player)
      .sort((a, b) => b.gamesAgainst - a.gamesAgainst)
      .slice(0, 5);

    // Favorite opponents (highest win rate, min 2 games)
    const favoriteOpponents: PlayerStats['favoriteOpponents'] = Object.entries(opponentStats)
      .filter(([_, stats]) => stats.games >= 2)
      .map(([oppId, stats]) => ({
        player: playerMap.get(oppId)!,
        gamesAgainst: stats.games,
        winsAgainst: stats.wins,
        lossesAgainst: stats.games - stats.wins,
        winRate: Math.round((stats.wins / stats.games) * 100)
      }))
      .filter(r => r.player)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 3);

    // Build full game history list (all games, filtered on frontend by time range)
    const recentGames: PlayerStats['recentGames'] = games.map(game => {
      const gameParticipantsList = allParticipants.filter(p => p.gameId === game.id);
      const playerInGame = gameParticipantsList.find(p => p.playerId === playerId)!;
      const playerTeam = playerInGame.team;
      
      const partner = gameParticipantsList.find(
        p => p.team === playerTeam && p.playerId !== playerId
      );
      const opponents = gameParticipantsList.filter(
        p => p.team !== playerTeam
      );

      const pointsChange = playerInGame.skillScoreAfter - playerInGame.skillScoreBefore;
      const pointsGained = pointsChange > 0 ? pointsChange : 0;
      const pointsLost = pointsChange < 0 ? Math.abs(pointsChange) : 0;

      return {
        gameId: game.id,
        sessionId: game.sessionId,
        partnerId: partner ? partner.playerId : null,
        partnerName: partner ? (playerMap.get(partner.playerId)?.name || 'Unknown') : 'Solo',
        opponentIds: opponents.map(o => o.playerId),
        opponentNames: opponents.map(o => playerMap.get(o.playerId)?.name || 'Unknown'),
        won: game.winningTeam === playerTeam,
        score: `${game.team1Score}-${game.team2Score}`,
        date: game.createdAt,
        pointsGained: pointsGained > 0 ? pointsGained : undefined,
        pointsLost: pointsLost > 0 ? pointsLost : undefined,
        skillScoreBefore: playerInGame.skillScoreBefore,
        skillScoreAfter: playerInGame.skillScoreAfter
      };
    });

    return {
      player,
      playerPhotoUrl,
      winRate: player.gamesPlayed > 0 ? Math.round((player.wins / player.gamesPlayed) * 100) : 0,
      totalGames: player.gamesPlayed,
      totalWins: player.wins,
      currentStreak,
      longestWinStreak,
      longestLossStreak,
      rankBySkillScore,
      rankByWins,
      rankByWinRate,
      totalPlayersRanked: allPlayers.length,
      performanceTrend,
      recentWinRate,
      avgScoreDifferential,
      avgPointsFor,
      avgPointsAgainst,
      bestPartner,
      frequentPartners,
      rivals,
      favoriteOpponents,
      recentGames
    };
  }

  // Court operations
  async getCourt(id: string): Promise<Court | undefined> {
    const [court] = await db.select().from(courts).where(eq(courts.id, id));
    return court || undefined;
  }

  async getCourtsBySession(sessionId: string): Promise<Court[]> {
    return await db.select().from(courts).where(eq(courts.sessionId, sessionId));
  }

  async createCourt(insertCourt: InsertCourt): Promise<Court> {
    const id = randomUUID();
    const [court] = await db
      .insert(courts)
      .values({ 
        ...insertCourt, 
        id,
        status: insertCourt.status || 'available',
        timeRemaining: insertCourt.timeRemaining || 0,
        winningTeam: insertCourt.winningTeam || null
      })
      .returning();
    return court;
  }

  async updateCourt(id: string, updates: Partial<Court>): Promise<Court | undefined> {
    const [updated] = await db
      .update(courts)
      .set(updates)
      .where(eq(courts.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteCourt(id: string): Promise<boolean> {
    // Delete related court players
    await db.delete(courtPlayersTable).where(eq(courtPlayersTable.courtId, id));
    
    // Delete the court
    const result = await db.delete(courts).where(eq(courts.id, id)).returning();
    return result.length > 0;
  }

  // Court players operations
  async getCourtPlayers(courtId: string): Promise<string[]> {
    const playerData = await db
      .select()
      .from(courtPlayersTable)
      .where(eq(courtPlayersTable.courtId, courtId));
    return playerData.map(cp => cp.playerId);
  }

  async getCourtPlayersWithTeams(courtId: string): Promise<CourtPlayer[]> {
    return await db
      .select()
      .from(courtPlayersTable)
      .where(eq(courtPlayersTable.courtId, courtId));
  }

  async setCourtPlayers(courtId: string, playerIds: string[]): Promise<void> {
    // Legacy method - auto-assign teams
    const assignments = playerIds.map((playerId, index) => ({
      playerId,
      team: index < Math.ceil(playerIds.length / 2) ? 1 : 2
    }));
    await this.setCourtPlayersWithTeams(courtId, assignments);
  }

  async setCourtPlayersWithTeams(courtId: string, assignments: { playerId: string; team: number }[]): Promise<void> {
    // Clear existing court players
    await db.delete(courtPlayersTable).where(eq(courtPlayersTable.courtId, courtId));
    
    // Insert new assignments
    if (assignments.length > 0) {
      await db.insert(courtPlayersTable).values(
        assignments.map(a => ({
          courtId,
          playerId: a.playerId,
          team: a.team
        }))
      );
    }
  }

  // Queue operations (session-specific)
  async getQueue(sessionId: string): Promise<string[]> {
    const entries = await db
      .select()
      .from(queueEntries)
      .where(eq(queueEntries.sessionId, sessionId))
      .orderBy(queueEntries.position); // Ascending order - first in queue has lowest position
    return entries.map(e => e.playerId);
  }

  async setQueue(sessionId: string, playerIds: string[]): Promise<void> {
    // Clear existing queue for this session
    await db.delete(queueEntries).where(eq(queueEntries.sessionId, sessionId));
    
    // Insert new queue
    if (playerIds.length > 0) {
      await db.insert(queueEntries).values(
        playerIds.map((playerId, index) => ({
          id: randomUUID(),
          sessionId,
          playerId,
          position: index
        }))
      );
    }
  }

  async addToQueue(sessionId: string, playerId: string): Promise<void> {
    // Check if player already in queue for this session
    const existing = await db
      .select()
      .from(queueEntries)
      .where(and(
        eq(queueEntries.sessionId, sessionId),
        eq(queueEntries.playerId, playerId)
      ));
    
    if (existing.length === 0) {
      // Get max position for this session
      const allEntries = await db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.sessionId, sessionId));
      const maxPosition = allEntries.length > 0 
        ? Math.max(...allEntries.map(e => e.position)) 
        : -1;
      
      await db.insert(queueEntries).values({
        id: randomUUID(),
        sessionId,
        playerId,
        position: maxPosition + 1
      });
    }
  }

  async removeFromQueue(sessionId: string, playerId: string): Promise<void> {
    await db.delete(queueEntries).where(
      and(
        eq(queueEntries.sessionId, sessionId),
        eq(queueEntries.playerId, playerId)
      )
    );
  }

  // Complex queries
  async getCourtsWithPlayers(sessionId: string): Promise<CourtWithPlayers[]> {
    const allCourts = await this.getCourtsBySession(sessionId);
    const courtsWithPlayers: CourtWithPlayers[] = [];

    for (const court of allCourts) {
      const courtPlayerData = await this.getCourtPlayersWithTeams(court.id);
      const playersWithTeams = (await Promise.all(
        courtPlayerData.map(async cp => {
          const player = await this.getPlayer(cp.playerId);
          if (!player) return null;
          return { ...player, team: cp.team };
        })
      )).filter((p): p is Player & { team: number } => p !== null);

      courtsWithPlayers.push({
        ...court,
        players: playersWithTeams,
      });
    }

    return courtsWithPlayers;
  }

  async getSessionGameHistory(sessionId: string): Promise<any[]> {
    const games = await db
      .select()
      .from(gameResults)
      .where(eq(gameResults.sessionId, sessionId))
      .orderBy(desc(gameResults.createdAt));
    
    return games;
  }

  async getSessionGameParticipants(sessionId: string): Promise<(GameParticipant & { createdAt: Date })[]> {
    // Join game participants with game results to get session ID and createdAt
    const participants = await db
      .select({
        gameId: gameParticipants.gameId,
        playerId: gameParticipants.playerId,
        team: gameParticipants.team,
        skillScoreBefore: gameParticipants.skillScoreBefore,
        skillScoreAfter: gameParticipants.skillScoreAfter,
        createdAt: gameResults.createdAt,
      })
      .from(gameParticipants)
      .innerJoin(gameResults, eq(gameParticipants.gameId, gameResults.id))
      .where(eq(gameResults.sessionId, sessionId))
      .orderBy(desc(gameResults.createdAt));
    
    return participants;
  }

  // ============================================================
  // MARKETPLACE OPERATIONS
  // ============================================================

  async createMarketplaceUser(user: InsertMarketplaceUser): Promise<MarketplaceUser> {
    const id = randomUUID();
    const [created] = await db
      .insert(marketplaceUsers)
      .values({ ...user, id })
      .returning();
    return created;
  }

  async getMarketplaceUser(id: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db.select().from(marketplaceUsers).where(eq(marketplaceUsers.id, id));
    return user || undefined;
  }

  async getMarketplaceUserByResetToken(token: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db
      .select()
      .from(marketplaceUsers)
      .where(eq(marketplaceUsers.resetToken, token));
    return user || undefined;
  }

  async getMarketplaceUserByVerificationToken(token: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db
      .select()
      .from(marketplaceUsers)
      .where(eq(marketplaceUsers.emailVerificationToken, token));
    return user || undefined;
  }

  async backfillEmailVerifiedForGoogleUsers(): Promise<number> {
    // Idempotent: any account with a googleId is by definition email-verified.
    const result = await db
      .update(marketplaceUsers)
      .set({ emailVerified: true })
      .where(and(
        isNotNull(marketplaceUsers.googleId),
        eq(marketplaceUsers.emailVerified, false),
      ))
      .returning({ id: marketplaceUsers.id });
    return result.length;
  }

  async getMarketplaceUserByEmail(email: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db.select().from(marketplaceUsers).where(eq(marketplaceUsers.email, email));
    return user || undefined;
  }

  async getMarketplaceUserByLinkedPlayerId(playerId: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db
      .select()
      .from(marketplaceUsers)
      .where(eq(marketplaceUsers.linkedPlayerId, playerId));
    return user || undefined;
  }

  async createPlayerLinkOtp(input: { marketplaceUserId: string; playerId: string; channel: string; destination: string; codeHash: string; expiresAt: Date }): Promise<PlayerLinkOtp> {
    const [row] = await db.insert(playerLinkOtps).values({
      id: randomUUID(),
      marketplaceUserId: input.marketplaceUserId,
      playerId: input.playerId,
      channel: input.channel,
      destination: input.destination,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    }).returning();
    return row;
  }

  async getLatestActivePlayerLinkOtp(marketplaceUserId: string, playerId: string): Promise<PlayerLinkOtp | undefined> {
    const [row] = await db
      .select()
      .from(playerLinkOtps)
      .where(and(
        eq(playerLinkOtps.marketplaceUserId, marketplaceUserId),
        eq(playerLinkOtps.playerId, playerId),
        sql`${playerLinkOtps.consumedAt} IS NULL`,
        sql`${playerLinkOtps.expiresAt} > NOW()`,
      ))
      .orderBy(desc(playerLinkOtps.createdAt))
      .limit(1);
    return row || undefined;
  }

  async countPlayerLinkOtpsForUserSince(marketplaceUserId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(playerLinkOtps)
      .where(and(
        eq(playerLinkOtps.marketplaceUserId, marketplaceUserId),
        gte(playerLinkOtps.createdAt, since),
      ));
    return row?.c ?? 0;
  }

  async countPlayerLinkOtpsForPairSince(marketplaceUserId: string, playerId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(playerLinkOtps)
      .where(and(
        eq(playerLinkOtps.marketplaceUserId, marketplaceUserId),
        eq(playerLinkOtps.playerId, playerId),
        gte(playerLinkOtps.createdAt, since),
      ));
    return row?.c ?? 0;
  }

  async incrementPlayerLinkOtpAttempts(otpId: string): Promise<PlayerLinkOtp | undefined> {
    const [row] = await db
      .update(playerLinkOtps)
      .set({ attempts: sql`${playerLinkOtps.attempts} + 1` })
      .where(eq(playerLinkOtps.id, otpId))
      .returning();
    return row || undefined;
  }

  async consumePlayerLinkOtp(otpId: string): Promise<void> {
    await db
      .update(playerLinkOtps)
      .set({ consumedAt: new Date() })
      .where(eq(playerLinkOtps.id, otpId));
  }

  async createPlayerContactChangeRequest(input: { marketplaceUserId: string; playerId: string; field: 'email' | 'phone'; oldValue: string | null; newValue: string; codeHash: string; expiresAt: Date }): Promise<PlayerContactChangeRequest> {
    const [row] = await db.insert(playerContactChangeRequests).values({
      id: randomUUID(),
      marketplaceUserId: input.marketplaceUserId,
      playerId: input.playerId,
      field: input.field,
      oldValue: input.oldValue,
      newValue: input.newValue,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    }).returning();
    return row;
  }

  async getLatestActivePlayerContactChangeRequest(marketplaceUserId: string, playerId: string): Promise<PlayerContactChangeRequest | undefined> {
    const [row] = await db
      .select()
      .from(playerContactChangeRequests)
      .where(and(
        eq(playerContactChangeRequests.marketplaceUserId, marketplaceUserId),
        eq(playerContactChangeRequests.playerId, playerId),
        sql`${playerContactChangeRequests.consumedAt} IS NULL`,
        sql`${playerContactChangeRequests.expiresAt} > NOW()`,
        eq(playerContactChangeRequests.status, 'pending'),
      ))
      .orderBy(desc(playerContactChangeRequests.createdAt))
      .limit(1);
    return row || undefined;
  }

  async countPlayerContactChangeRequestsForUserSince(marketplaceUserId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(playerContactChangeRequests)
      .where(and(
        eq(playerContactChangeRequests.marketplaceUserId, marketplaceUserId),
        gte(playerContactChangeRequests.createdAt, since),
      ));
    return row?.c ?? 0;
  }

  async incrementPlayerContactChangeAttempts(requestId: string): Promise<PlayerContactChangeRequest | undefined> {
    const [row] = await db
      .update(playerContactChangeRequests)
      .set({ attempts: sql`${playerContactChangeRequests.attempts} + 1` })
      .where(eq(playerContactChangeRequests.id, requestId))
      .returning();
    return row || undefined;
  }

  async consumePlayerContactChangeRequest(requestId: string, status: 'verified' | 'cancelled'): Promise<void> {
    await db
      .update(playerContactChangeRequests)
      .set({
        consumedAt: new Date(),
        status,
        verifiedAt: status === 'verified' ? new Date() : null,
      })
      .where(eq(playerContactChangeRequests.id, requestId));
  }

  async createMarketplaceUserContactChange(input: { marketplaceUserId: string; field: 'email' | 'phone'; oldValue: string | null; newValue: string; codeHash: string; expiresAt: Date }): Promise<MarketplaceUserContactChange> {
    const [row] = await db.insert(marketplaceUserContactChanges).values({
      id: randomUUID(),
      marketplaceUserId: input.marketplaceUserId,
      field: input.field,
      oldValue: input.oldValue,
      newValue: input.newValue,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    }).returning();
    return row;
  }

  async getLatestActiveMarketplaceUserContactChange(marketplaceUserId: string): Promise<MarketplaceUserContactChange | undefined> {
    const [row] = await db
      .select()
      .from(marketplaceUserContactChanges)
      .where(and(
        eq(marketplaceUserContactChanges.marketplaceUserId, marketplaceUserId),
        sql`${marketplaceUserContactChanges.consumedAt} IS NULL`,
        sql`${marketplaceUserContactChanges.expiresAt} > NOW()`,
        eq(marketplaceUserContactChanges.status, 'pending'),
      ))
      .orderBy(desc(marketplaceUserContactChanges.createdAt))
      .limit(1);
    return row || undefined;
  }

  async countMarketplaceUserContactChangesForUserSince(marketplaceUserId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(marketplaceUserContactChanges)
      .where(and(
        eq(marketplaceUserContactChanges.marketplaceUserId, marketplaceUserId),
        gte(marketplaceUserContactChanges.createdAt, since),
      ));
    return row?.c ?? 0;
  }

  async incrementMarketplaceUserContactChangeAttempts(requestId: string): Promise<MarketplaceUserContactChange | undefined> {
    const [row] = await db
      .update(marketplaceUserContactChanges)
      .set({ attempts: sql`${marketplaceUserContactChanges.attempts} + 1` })
      .where(eq(marketplaceUserContactChanges.id, requestId))
      .returning();
    return row || undefined;
  }

  async consumeMarketplaceUserContactChange(requestId: string, status: 'verified' | 'cancelled'): Promise<void> {
    await db
      .update(marketplaceUserContactChanges)
      .set({
        consumedAt: new Date(),
        status,
        verifiedAt: status === 'verified' ? new Date() : null,
      })
      .where(eq(marketplaceUserContactChanges.id, requestId));
  }

  async getMarketplaceUserByGoogleId(googleId: string): Promise<MarketplaceUser | undefined> {
    const [user] = await db
      .select()
      .from(marketplaceUsers)
      .where(eq(marketplaceUsers.googleId, googleId));
    return user || undefined;
  }

  async searchMarketplaceUsersByName(query: string): Promise<MarketplaceUser[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    return await db
      .select()
      .from(marketplaceUsers)
      .where(sql`LOWER(${marketplaceUsers.name}) LIKE ${lowerQuery}`)
      .orderBy(asc(marketplaceUsers.name))
      .limit(10);
  }

  async updateMarketplaceUser(id: string, updates: Partial<MarketplaceUser>): Promise<MarketplaceUser | undefined> {
    const [updated] = await db
      .update(marketplaceUsers)
      .set(updates)
      .where(eq(marketplaceUsers.id, id))
      .returning();
    return updated || undefined;
  }

  async updateMarketplaceUserPhoto(id: string, photoUrl: string | null): Promise<MarketplaceUser | undefined> {
    return this.updateMarketplaceUser(id, { photoUrl });
  }

  // Atomically link a player to a marketplace user only if no other account already
  // owns it. Returns the updated user on success, or undefined if the player is
  // already claimed by someone else (race-safe at the SQL level).
  async linkPlayerIfUnclaimed(userId: string, playerId: string): Promise<MarketplaceUser | undefined> {
    const [updated] = await db
      .update(marketplaceUsers)
      .set({ linkedPlayerId: playerId })
      .where(sql`${marketplaceUsers.id} = ${userId} AND NOT EXISTS (
        SELECT 1 FROM ${marketplaceUsers} AS other
        WHERE other.linked_player_id = ${playerId} AND other.id <> ${userId}
      )`)
      .returning();
    return updated || undefined;
  }

  async getAllMarketplaceUsers(): Promise<MarketplaceUser[]> {
    return await db.select().from(marketplaceUsers).orderBy(desc(marketplaceUsers.createdAt));
  }

  async createMarketplaceAuthSession(userId: string, refreshToken: string, expiresAt: Date): Promise<void> {
    await db.insert(marketplaceAuthSessions).values({
      id: randomUUID(),
      userId,
      refreshToken,
      expiresAt,
    });
  }

  async findMarketplaceAuthSession(refreshToken: string): Promise<{ id: string; userId: string; refreshToken: string; expiresAt: Date } | undefined> {
    const [session] = await db
      .select()
      .from(marketplaceAuthSessions)
      .where(eq(marketplaceAuthSessions.refreshToken, refreshToken));
    return session || undefined;
  }

  async deleteMarketplaceAuthSession(id: string): Promise<void> {
    await db.delete(marketplaceAuthSessions).where(eq(marketplaceAuthSessions.id, id));
  }

  async createBookableSession(session: InsertBookableSession): Promise<BookableSession> {
    const id = randomUUID();
    const [created] = await db
      .insert(bookableSessions)
      .values({ ...session, id })
      .returning();
    return created;
  }

  async getBookableSession(id: string): Promise<BookableSession | undefined> {
    const [session] = await db.select().from(bookableSessions).where(eq(bookableSessions.id, id));
    return session || undefined;
  }

  async getBookableSessionByLinkedSessionId(linkedSessionId: string): Promise<BookableSession | undefined> {
    const [session] = await db.select().from(bookableSessions).where(eq(bookableSessions.linkedSessionId, linkedSessionId));
    return session || undefined;
  }

  async getBookableSessionWithAvailability(id: string): Promise<BookableSessionWithAvailability | undefined> {
    const session = await this.getBookableSession(id);
    if (!session) return undefined;
    const count = await this.getBookingCountForSession(id);
    const waitlistCount = await this.getWaitlistCountForSession(id);
    return { ...session, spotsRemaining: Math.max(0, session.capacity - count), totalBookings: count, waitlistCount };
  }

  async getAllBookableSessions(): Promise<BookableSessionWithAvailability[]> {
    const allSessions = await db.select().from(bookableSessions)
      .where(sql`${bookableSessions.linkedSessionId} IS NOT NULL`)
      .orderBy(asc(bookableSessions.date));
    const result: BookableSessionWithAvailability[] = [];
    for (const session of allSessions) {
      const count = await this.getBookingCountForSession(session.id);
      const waitlistCount = await this.getWaitlistCountForSession(session.id);
      result.push({ ...session, spotsRemaining: Math.max(0, session.capacity - count), totalBookings: count, waitlistCount });
    }
    return result;
  }

  async getUpcomingBookableSessions(): Promise<BookableSessionWithAvailability[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const allSessions = await db.select().from(bookableSessions)
      .where(and(
        sql`${bookableSessions.linkedSessionId} IS NOT NULL`,
        gte(bookableSessions.date, today)
      ))
      .orderBy(asc(bookableSessions.date));
    const result: BookableSessionWithAvailability[] = [];
    for (const session of allSessions) {
      const count = await this.getBookingCountForSession(session.id);
      const waitlistCount = await this.getWaitlistCountForSession(session.id);
      result.push({ ...session, spotsRemaining: Math.max(0, session.capacity - count), totalBookings: count, waitlistCount });
    }
    return result;
  }

  async updateBookableSession(id: string, updates: Partial<BookableSession>): Promise<BookableSession | undefined> {
    const [updated] = await db
      .update(bookableSessions)
      .set(updates)
      .where(eq(bookableSessions.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteBookableSession(id: string): Promise<boolean> {
    await db.delete(bookings).where(eq(bookings.sessionId, id));
    const result = await db.delete(bookableSessions).where(eq(bookableSessions.id, id)).returning();
    return result.length > 0;
  }

  async createBooking(booking: InsertBooking): Promise<Booking> {
    const id = randomUUID();
    const [created] = await db
      .insert(bookings)
      .values({ ...booking, id })
      .returning();
    return created;
  }

  async getBooking(id: string): Promise<Booking | undefined> {
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));
    return booking || undefined;
  }

  async getBookingByZiinaPaymentIntentId(intentId: string): Promise<Booking | undefined> {
    const [booking] = await db.select().from(bookings).where(eq(bookings.ziinaPaymentIntentId, intentId));
    return booking || undefined;
  }

  async getBookingWithDetails(id: string): Promise<BookingWithDetails | undefined> {
    const booking = await this.getBooking(id);
    if (!booking) return undefined;
    const session = await this.getBookableSession(booking.sessionId);
    if (!session) return undefined;
    const user = await this.getMarketplaceUser(booking.userId);
    const guests = await this.getBookingGuests(id);
    return { ...booking, session, user: user || undefined, guests };
  }

  async getUserBookings(userId: string): Promise<BookingWithDetails[]> {
    const userBookings = await db
      .select()
      .from(bookings)
      .where(eq(bookings.userId, userId))
      .orderBy(desc(bookings.createdAt));
    const result: BookingWithDetails[] = [];
    for (const booking of userBookings) {
      const session = await this.getBookableSession(booking.sessionId);
      if (session) {
        const guests = await this.getBookingGuests(booking.id);
        result.push({ ...booking, session, guests });
      }
    }
    return result;
  }

  async getUserBookingForSession(userId: string, sessionId: string): Promise<Booking | undefined> {
    // Only return an active (non-cancelled) booking so historical cancelled rows don't block re-booking
    const results = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.sessionId, sessionId)))
      .orderBy(desc(bookings.createdAt));
    return results.find(b => b.status !== 'cancelled');
  }

  async getSessionBookings(sessionId: string): Promise<BookingWithDetails[]> {
    const sessionBookings = await db
      .select()
      .from(bookings)
      .where(eq(bookings.sessionId, sessionId))
      .orderBy(desc(bookings.createdAt));
    const result: BookingWithDetails[] = [];
    for (const booking of sessionBookings) {
      const session = await this.getBookableSession(booking.sessionId);
      const user = await this.getMarketplaceUser(booking.userId);
      const guests = await this.getBookingGuests(booking.id);
      if (session) result.push({ ...booking, session, user: user || undefined, guests });
    }
    return result;
  }

  async updateBooking(id: string, updates: Partial<Booking>): Promise<Booking | undefined> {
    const [updated] = await db
      .update(bookings)
      .set(updates)
      .where(eq(bookings.id, id))
      .returning();
    return updated || undefined;
  }

  async getBookingCountForSession(sessionId: string): Promise<number> {
    // Count total spots across all confirmed/attended/pending_payment bookings.
    // pending_payment bookings hold a reserved spot (waitlist-promoted, awaiting Ziina payment).
    const activeBookings = await db
      .select({ spotsBooked: bookings.spotsBooked })
      .from(bookings)
      .where(and(
        eq(bookings.sessionId, sessionId),
        sql`${bookings.status} IN ('confirmed', 'attended', 'pending_payment')`
      ));
    return activeBookings.reduce((sum, b) => sum + (b.spotsBooked ?? 1), 0);
  }

  async getWaitlistedBookingsForSession(sessionId: string): Promise<Booking[]> {
    return await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.sessionId, sessionId), eq(bookings.status, 'waitlisted')))
      .orderBy(asc(bookings.createdAt));
  }

  async getWaitlistCountForSession(sessionId: string): Promise<number> {
    const waitlisted = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.sessionId, sessionId), eq(bookings.status, 'waitlisted')));
    return waitlisted.length;
  }

  async createBookingGuest(guest: InsertBookingGuest): Promise<BookingGuest> {
    const id = randomUUID();
    const [created] = await db
      .insert(bookingGuests)
      .values({ ...guest, id })
      .returning();
    return created;
  }

  async getBookingGuests(bookingId: string): Promise<import("@shared/schema").BookingGuestWithLinked[]> {
    const rows = await db
      .select({
        id: bookingGuests.id,
        bookingId: bookingGuests.bookingId,
        name: bookingGuests.name,
        email: bookingGuests.email,
        linkedUserId: bookingGuests.linkedUserId,
        isPrimary: bookingGuests.isPrimary,
        status: bookingGuests.status,
        cancelledAt: bookingGuests.cancelledAt,
        cancellationToken: bookingGuests.cancellationToken,
        createdAt: bookingGuests.createdAt,
        linkedPlayerId: marketplaceUsers.linkedPlayerId,
      })
      .from(bookingGuests)
      .leftJoin(marketplaceUsers, eq(bookingGuests.linkedUserId, marketplaceUsers.id))
      .where(eq(bookingGuests.bookingId, bookingId))
      .orderBy(asc(bookingGuests.createdAt));
    return rows;
  }

  async getBookingGuestByToken(token: string): Promise<BookingGuest | undefined> {
    const [guest] = await db
      .select()
      .from(bookingGuests)
      .where(eq(bookingGuests.cancellationToken, token));
    return guest || undefined;
  }

  async getBookingGuestByPendingPaymentIntentId(intentId: string): Promise<BookingGuest | undefined> {
    const [guest] = await db
      .select()
      .from(bookingGuests)
      .where(eq(bookingGuests.pendingPaymentIntentId, intentId))
      .limit(1);
    return guest || undefined;
  }

  async deleteBookingGuest(id: string): Promise<void> {
    await db.delete(bookingGuests).where(eq(bookingGuests.id, id));
  }

  async updateBookingGuest(id: string, updates: Partial<BookingGuest>): Promise<BookingGuest | undefined> {
    const [updated] = await db
      .update(bookingGuests)
      .set(updates)
      .where(eq(bookingGuests.id, id))
      .returning();
    return updated || undefined;
  }

  async getActiveGuestCountForSession(sessionId: string): Promise<number> {
    // Count active guests linked to confirmed/attended bookings for this session
    const activeBookingIds = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(
        eq(bookings.sessionId, sessionId),
        sql`${bookings.status} IN ('confirmed', 'attended')`
      ));
    if (activeBookingIds.length === 0) return 0;
    const ids = activeBookingIds.map(b => b.id);
    const guestRows = await db
      .select()
      .from(bookingGuests)
      .where(and(
        inArray(bookingGuests.bookingId, ids),
        eq(bookingGuests.status, 'confirmed')
      ));
    return guestRows.length;
  }

  async linkGuestsByEmail(email: string, userId: string): Promise<void> {
    // Only link non-primary guest rows — primary rows are already owned by the booker
    await db
      .update(bookingGuests)
      .set({ linkedUserId: userId })
      .where(and(
        eq(bookingGuests.email, email),
        eq(bookingGuests.isPrimary, false),
        sql`${bookingGuests.linkedUserId} IS NULL`,
      ));
  }

  async getGuestBookingsForUser(userId: string): Promise<BookingWithDetails[]> {
    // Find confirmed non-primary booking_guests rows linked to this user
    // isPrimary=true rows belong to the booking owner — shown via getUserBookings, not here
    const guestRows = await db
      .select()
      .from(bookingGuests)
      .where(and(
        eq(bookingGuests.linkedUserId, userId),
        eq(bookingGuests.status, 'confirmed'),
        eq(bookingGuests.isPrimary, false),
      ));
    const result: BookingWithDetails[] = [];
    for (const guest of guestRows) {
      const booking = await this.getBookingWithDetails(guest.bookingId);
      if (booking) {
        const primaryBooker = await this.getMarketplaceUser(booking.userId);
        result.push({ ...booking, isGuestBooking: true, bookedByName: primaryBooker?.name, myGuestId: guest.id });
      }
    }
    return result;
  }

  async getBookingsNeedingReminder(): Promise<BookingWithDetails[]> {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const activeBookings = await db
      .select()
      .from(bookings)
      .where(and(
        sql`${bookings.status} IN ('confirmed', 'attended')`,
        sql`${bookings.reminderSentAt} IS NULL`,
      ));

    const result: BookingWithDetails[] = [];
    for (const booking of activeBookings) {
      const session = await this.getBookableSession(booking.sessionId);
      if (!session) continue;

      // Compute actual session start datetime from date + startTime (same pattern as cancellation cutoff)
      // startTime is stored as "HH:MM" text
      const [hours, minutes] = session.startTime.split(':').map(Number);
      const sessionStartAt = new Date(session.date);
      sessionStartAt.setHours(hours, minutes, 0, 0);

      if (sessionStartAt >= windowStart && sessionStartAt <= windowEnd) {
        const user = await this.getMarketplaceUser(booking.userId);
        result.push({ ...booking, session, user: user || undefined });
      }
    }
    return result;
  }

  async getExpiredPendingPaymentBookings(olderThanMs: number): Promise<Booking[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return db
      .select()
      .from(bookings)
      .where(and(
        eq(bookings.status, 'pending_payment'),
        sql`${bookings.promotedAt} IS NOT NULL`,
        lt(bookings.promotedAt, cutoff),
      ));
  }

  async createPayment(payment: InsertPayment): Promise<Payment> {
    const id = randomUUID();
    const [created] = await db
      .insert(payments)
      .values({ ...payment, id })
      .returning();
    return created;
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    const [payment] = await db.select().from(payments).where(eq(payments.id, id));
    return payment || undefined;
  }

  async getPaymentByBookingId(bookingId: string): Promise<Payment | undefined> {
    const [payment] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    return payment || undefined;
  }

  async getPaymentsByBookingId(bookingId: string): Promise<Payment[]> {
    return db.select().from(payments).where(eq(payments.bookingId, bookingId));
  }

  async updatePayment(id: string, updates: Partial<Payment>): Promise<Payment | undefined> {
    const [updated] = await db
      .update(payments)
      .set(updates)
      .where(eq(payments.id, id))
      .returning();
    return updated || undefined;
  }

  async createMarketplaceNotification(data: { userId: string; type: string; title: string; message: string; relatedBookingId?: string }): Promise<MarketplaceNotification> {
    const id = randomUUID();
    const [created] = await db
      .insert(marketplaceNotifications)
      .values({ id, ...data, relatedBookingId: data.relatedBookingId || null })
      .returning();
    return created;
  }

  async getNotificationsForUser(userId: string): Promise<MarketplaceNotification[]> {
    return await db
      .select()
      .from(marketplaceNotifications)
      .where(eq(marketplaceNotifications.userId, userId))
      .orderBy(desc(marketplaceNotifications.createdAt));
  }

  async markNotificationRead(id: string): Promise<void> {
    await db
      .update(marketplaceNotifications)
      .set({ read: true })
      .where(eq(marketplaceNotifications.id, id));
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await db
      .update(marketplaceNotifications)
      .set({ read: true })
      .where(eq(marketplaceNotifications.userId, userId));
  }

  async getRefundNotifications(): Promise<RefundNotificationWithDetails[]> {
    const rows = await db
      .select({
        id: marketplaceNotifications.id,
        message: marketplaceNotifications.message,
        createdAt: marketplaceNotifications.createdAt,
        read: marketplaceNotifications.read,
        relatedBookingId: marketplaceNotifications.relatedBookingId,
        amountAed: bookings.amountAed,
        spotsBooked: bookings.spotsBooked,
        paymentMethod: bookings.paymentMethod,
        ziinaPaymentIntentId: bookings.ziinaPaymentIntentId,
        bookingSessionId: bookings.sessionId,
        playerName: marketplaceUsers.name,
        playerEmail: marketplaceUsers.email,
        sessionTitle: bookableSessions.title,
        sessionDate: bookableSessions.date,
        sessionVenueName: bookableSessions.venueName,
      })
      .from(marketplaceNotifications)
      .leftJoin(bookings, eq(marketplaceNotifications.relatedBookingId, bookings.id))
      .leftJoin(marketplaceUsers, eq(bookings.userId, marketplaceUsers.id))
      .leftJoin(bookableSessions, eq(bookings.sessionId, bookableSessions.id))
      .where(eq(marketplaceNotifications.type, 'refund_required'))
      .orderBy(desc(marketplaceNotifications.createdAt));

    return rows.map(row => ({
      id: row.id,
      message: row.message,
      createdAt: row.createdAt,
      read: row.read,
      relatedBookingId: row.relatedBookingId ?? null,
      amountAed: row.amountAed ?? null,
      spotsBooked: row.spotsBooked ?? null,
      paymentMethod: row.paymentMethod ?? null,
      ziinaPaymentIntentId: row.ziinaPaymentIntentId ?? null,
      bookingSessionId: row.bookingSessionId ?? null,
      playerName: row.playerName ?? null,
      playerEmail: row.playerEmail ?? null,
      sessionTitle: row.sessionTitle ?? null,
      sessionDate: row.sessionDate ?? null,
      sessionVenueName: row.sessionVenueName ?? null,
    }));
  }

  async resolveRefundNotification(id: string): Promise<boolean> {
    const [updated] = await db
      .update(marketplaceNotifications)
      .set({ read: true })
      .where(and(eq(marketplaceNotifications.id, id), eq(marketplaceNotifications.type, 'refund_required')))
      .returning({ id: marketplaceNotifications.id });
    return !!updated;
  }

  // Score dispute operations
  async createScoreDispute(data: { gameResultId: string; filedByUserId: string; note?: string }): Promise<ScoreDispute> {
    const id = randomUUID();
    const [dispute] = await db
      .insert(scoreDisputes)
      .values({ id, gameResultId: data.gameResultId, filedByUserId: data.filedByUserId, note: data.note ?? null, status: 'open' })
      .returning();
    return dispute;
  }

  // Atomic insert + first-flag detection. SELECT FOR UPDATE on the parent
  // game_results row serializes concurrent flag attempts on the same game:
  //  - Two concurrent first-flag requests by different players: the second
  //    sees the first's dispute committed and reports isFirstForGame=false,
  //    so admin fan-out happens exactly once.
  //  - Two concurrent flag requests by the same player: the second sees its
  //    own existing dispute and returns it with alreadyFlagged=true, with
  //    no second insert and no fan-out.
  async createScoreDisputeAtomic(data: { gameResultId: string; filedByUserId: string; note?: string }): Promise<{ dispute: ScoreDispute; isFirstForGame: boolean; alreadyFlagged: boolean }> {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${gameResults} WHERE ${gameResults.id} = ${data.gameResultId} FOR UPDATE`);

      const [existingForUser] = await tx
        .select()
        .from(scoreDisputes)
        .where(and(
          eq(scoreDisputes.gameResultId, data.gameResultId),
          eq(scoreDisputes.filedByUserId, data.filedByUserId),
        ))
        .limit(1);
      if (existingForUser) {
        return { dispute: existingForUser, isFirstForGame: false, alreadyFlagged: true };
      }

      const [existingForGame] = await tx
        .select({ id: scoreDisputes.id })
        .from(scoreDisputes)
        .where(eq(scoreDisputes.gameResultId, data.gameResultId))
        .limit(1);
      const isFirstForGame = !existingForGame;

      const id = randomUUID();
      const [dispute] = await tx
        .insert(scoreDisputes)
        .values({ id, gameResultId: data.gameResultId, filedByUserId: data.filedByUserId, note: data.note ?? null, status: 'open' })
        .returning();
      return { dispute, isFirstForGame, alreadyFlagged: false };
    });
  }

  async getScoreDispute(id: string): Promise<ScoreDispute | undefined> {
    const [dispute] = await db.select().from(scoreDisputes).where(eq(scoreDisputes.id, id));
    return dispute;
  }

  async getDisputeByUserAndGame(userId: string, gameResultId: string): Promise<ScoreDispute | undefined> {
    const [dispute] = await db
      .select()
      .from(scoreDisputes)
      .where(and(eq(scoreDisputes.filedByUserId, userId), eq(scoreDisputes.gameResultId, gameResultId)));
    return dispute;
  }

  async hasAnyDisputeForGame(gameResultId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: scoreDisputes.id })
      .from(scoreDisputes)
      .where(eq(scoreDisputes.gameResultId, gameResultId))
      .limit(1);
    return !!row;
  }

  async getAllDisputesWithDetails(): Promise<ScoreDisputeWithDetails[]> {
    const rows = await db
      .select({
        id: scoreDisputes.id,
        gameResultId: scoreDisputes.gameResultId,
        filedByUserId: scoreDisputes.filedByUserId,
        note: scoreDisputes.note,
        status: scoreDisputes.status,
        adminNote: scoreDisputes.adminNote,
        createdAt: scoreDisputes.createdAt,
        filedByName: marketplaceUsers.name,
        filedByEmail: marketplaceUsers.email,
        team1Score: gameResults.team1Score,
        team2Score: gameResults.team2Score,
        gameDate: gameResults.createdAt,
        sessionId: gameResults.sessionId,
      })
      .from(scoreDisputes)
      .innerJoin(marketplaceUsers, eq(scoreDisputes.filedByUserId, marketplaceUsers.id))
      .innerJoin(gameResults, eq(scoreDisputes.gameResultId, gameResults.id))
      .orderBy(desc(scoreDisputes.createdAt));
    return rows.map(r => ({
      ...r,
      gameScore: `${r.team1Score} - ${r.team2Score}`,
    }));
  }

  async getDisputesByUser(userId: string): Promise<ScoreDispute[]> {
    return db.select().from(scoreDisputes).where(eq(scoreDisputes.filedByUserId, userId)).orderBy(desc(scoreDisputes.createdAt));
  }

  async updateScoreDispute(id: string, updates: Partial<ScoreDispute>): Promise<ScoreDispute | undefined> {
    const [updated] = await db
      .update(scoreDisputes)
      .set(updates)
      .where(eq(scoreDisputes.id, id))
      .returning();
    return updated;
  }

  async getGameResult(id: string): Promise<GameResult | undefined> {
    const [row] = await db.select().from(gameResults).where(eq(gameResults.id, id)).limit(1);
    return row;
  }

  async getGameParticipants(gameId: string): Promise<GameParticipant[]> {
    return db.select().from(gameParticipants).where(eq(gameParticipants.gameId, gameId));
  }

  async listMarketplaceAdmins(): Promise<MarketplaceUser[]> {
    return db
      .select()
      .from(marketplaceUsers)
      .where(inArray(marketplaceUsers.role, ['admin', 'super_admin']));
  }

  async listSessionPendingSuggestionsWithDetails(sessionId: string): Promise<Array<MatchSuggestion & {
    courtName: string;
    players: Array<MatchSuggestionPlayer & { name: string }>;
  }>> {
    const parents = await db
      .select({
        id: matchSuggestions.id,
        sessionId: matchSuggestions.sessionId,
        courtId: matchSuggestions.courtId,
        suggestedAt: matchSuggestions.suggestedAt,
        pendingUntil: matchSuggestions.pendingUntil,
        status: matchSuggestions.status,
        approvedBy: matchSuggestions.approvedBy,
        includesActivePlayers: matchSuggestions.includesActivePlayers,
        createdAt: matchSuggestions.createdAt,
        courtName: courts.name,
      })
      .from(matchSuggestions)
      .innerJoin(courts, eq(matchSuggestions.courtId, courts.id))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        inArray(matchSuggestions.status, ['pending', 'approved', 'queued']),
      ))
      // pendingUntil ASC NULLS LAST → pending/approved (which always have a
      // real timestamp) sort first; queued rows (pendingUntil = null) trail.
      // The Court Captain panel filters its rendered set down to actionable
      // statuses anyway, but other consumers of this list get a stable
      // chronological order.
      .orderBy(sql`${matchSuggestions.pendingUntil} ASC NULLS LAST`);

    if (parents.length === 0) return [];

    const ids = parents.map(p => p.id);
    const childRows = await db
      .select({
        suggestionId: matchSuggestionPlayers.suggestionId,
        courtId: matchSuggestionPlayers.courtId,
        playerId: matchSuggestionPlayers.playerId,
        team: matchSuggestionPlayers.team,
        name: players.name,
      })
      .from(matchSuggestionPlayers)
      .innerJoin(players, eq(matchSuggestionPlayers.playerId, players.id))
      .where(inArray(matchSuggestionPlayers.suggestionId, ids));

    const byParent = new Map<string, Array<MatchSuggestionPlayer & { name: string }>>();
    for (const row of childRows) {
      const list = byParent.get(row.suggestionId) ?? [];
      list.push(row);
      byParent.set(row.suggestionId, list);
    }
    return parents.map(p => ({ ...p, players: byParent.get(p.id) ?? [] }));
  }

  async getLineupSwapCandidates(sessionId: string, suggestionId: string): Promise<{
    candidates: Array<{ playerId: string; name: string }>;
    playingPlayerIds: string[];
  }> {
    const suggestion = await this.getMatchSuggestion(suggestionId);
    if (!suggestion || suggestion.sessionId !== sessionId) {
      throw new Error('Suggestion not found');
    }
    if (suggestion.status !== 'pending' && suggestion.status !== 'queued') {
      throw new Error(`Suggestion status ${suggestion.status} is not editable`);
    }

    const lineupIds = new Set(suggestion.players.map(p => p.playerId));
    const queue = await this.getQueue(sessionId);
    const sittingOut = new Set(getSittingOutPlayers(sessionId));

    const onOtherOpenRows = await db
      .select({ playerId: matchSuggestionPlayers.playerId })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
        sql`${matchSuggestions.id} <> ${suggestionId}`,
      ));
    const onOtherOpen = new Set(onOtherOpenRows.map(r => r.playerId));

    const onCourtPlayingRows = await db
      .select({ playerId: matchSuggestionPlayers.playerId })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        eq(matchSuggestions.status, 'playing'),
      ));
    const playingPlayerIds = new Set(onCourtPlayingRows.map(r => r.playerId));

    const sessionCourts = await this.getCourtsBySession(sessionId);
    for (const court of sessionCourts) {
      if (court.status === 'occupied' || court.status === 'playing') {
        const courtPlayerIds = await this.getCourtPlayers(court.id);
        for (const id of courtPlayerIds) playingPlayerIds.add(id);
      }
    }

    const eligibleQueueIds = queue.filter(id =>
      !sittingOut.has(id) &&
      !onOtherOpen.has(id) &&
      !lineupIds.has(id) &&
      !playingPlayerIds.has(id),
    );

    const candidatePlayers = eligibleQueueIds.length > 0
      ? await this.getPlayersByIds(eligibleQueueIds)
      : [];
    const nameById = new Map(candidatePlayers.map(p => [p.id, p.name]));
    const candidates = eligibleQueueIds
      .map(id => ({ playerId: id, name: nameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      candidates,
      playingPlayerIds: [...playingPlayerIds],
    };
  }

  async swapMatchSuggestionPlayers(
    sessionId: string,
    suggestionId: string,
    swaps: Array<{ removePlayerId: string; addPlayerId: string; team: number }>,
  ): Promise<(MatchSuggestion & {
    courtName: string;
    players: Array<MatchSuggestionPlayer & { name: string }>;
  })> {
    if (swaps.length === 0) {
      throw new Error('At least one swap is required');
    }

    const suggestion = await this.getMatchSuggestion(suggestionId);
    if (!suggestion || suggestion.sessionId !== sessionId) {
      throw new Error('Suggestion not found');
    }
    if (suggestion.status !== 'pending' && suggestion.status !== 'queued') {
      throw new Error(`Suggestion status ${suggestion.status} is not editable`);
    }

    const lineupByPlayer = new Map(suggestion.players.map(p => [p.playerId, p]));
    const removeIds = new Set<string>();
    const addIds = new Set<string>();
    for (const swap of swaps) {
      if (swap.team !== 1 && swap.team !== 2) {
        throw new Error('team must be 1 or 2');
      }
      const existing = lineupByPlayer.get(swap.removePlayerId);
      if (!existing) {
        throw new Error(`Player ${swap.removePlayerId} is not in this lineup`);
      }
      if (existing.team !== swap.team) {
        throw new Error(`Player ${swap.removePlayerId} is not on team ${swap.team}`);
      }
      if (removeIds.has(swap.removePlayerId)) {
        throw new Error(`Duplicate removePlayerId ${swap.removePlayerId}`);
      }
      if (addIds.has(swap.addPlayerId)) {
        throw new Error(`Duplicate addPlayerId ${swap.addPlayerId}`);
      }
      removeIds.add(swap.removePlayerId);
      addIds.add(swap.addPlayerId);
    }

    for (const addId of addIds) {
      const player = await this.getPlayer(addId);
      if (!player) {
        throw new Error(`Player ${addId} does not exist`);
      }
    }

    const queue = await this.getQueue(sessionId);
    const queueSet = new Set(queue);
    for (const addId of addIds) {
      if (!queueSet.has(addId)) {
        throw new Error(`Player ${addId} is not in the session queue`);
      }
    }

    const sittingOut = new Set(getSittingOutPlayers(sessionId));
    for (const addId of addIds) {
      if (sittingOut.has(addId)) {
        throw new Error(`Player ${addId} is sitting out`);
      }
    }

    const onOtherOpenRows = await db
      .select({ playerId: matchSuggestionPlayers.playerId })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
        sql`${matchSuggestions.id} <> ${suggestionId}`,
        inArray(matchSuggestionPlayers.playerId, [...addIds]),
      ));
    if (onOtherOpenRows.length > 0) {
      throw new Error('Replacement player is already assigned to another active suggestion');
    }

    const onCourtPlayingRows = await db
      .select({ playerId: matchSuggestionPlayers.playerId })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        eq(matchSuggestions.status, 'playing'),
        inArray(matchSuggestionPlayers.playerId, [...removeIds]),
      ));
    if (onCourtPlayingRows.length > 0) {
      throw new Error('Cannot swap a player who is currently on court playing');
    }

    const sessionCourts = await this.getCourtsBySession(sessionId);
    for (const court of sessionCourts) {
      if (court.status !== 'occupied' && court.status !== 'playing') continue;
      const courtPlayerIds = await this.getCourtPlayers(court.id);
      for (const removeId of removeIds) {
        if (courtPlayerIds.includes(removeId)) {
          throw new Error('Cannot swap a player who is currently on court playing');
        }
      }
    }

    const finalIds = new Set(suggestion.players.map(p => p.playerId));
    for (const swap of swaps) {
      if (finalIds.has(swap.addPlayerId)) {
        throw new Error(`Player ${swap.addPlayerId} is already in this lineup`);
      }
      finalIds.delete(swap.removePlayerId);
      finalIds.add(swap.addPlayerId);
    }
    if (finalIds.size !== 4) {
      throw new Error('Lineup must contain exactly 4 players after swaps');
    }

    await db.transaction(async (tx) => {
      for (const swap of swaps) {
        await tx
          .delete(matchSuggestionPlayers)
          .where(and(
            eq(matchSuggestionPlayers.suggestionId, suggestionId),
            eq(matchSuggestionPlayers.playerId, swap.removePlayerId),
          ));
        await tx.insert(matchSuggestionPlayers).values({
          suggestionId,
          courtId: suggestion.courtId,
          playerId: swap.addPlayerId,
          team: swap.team,
        });
      }
    });

    const all = await this.listSessionPendingSuggestionsWithDetails(sessionId);
    const updated = all.find(s => s.id === suggestionId);
    if (!updated) {
      throw new Error('Updated suggestion not found');
    }
    return updated;
  }

  // ── Player Personality Tags ────────────────────────────────────────────────

  async getAllTags(): Promise<Tag[]> {
    return db.select().from(tags).where(eq(tags.isActive, true)).orderBy(asc(tags.category), asc(tags.label));
  }

  async getTrendingTags(limit = 5): Promise<TrendingTag[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ tagId: playerTags.tagId, count: sql<number>`count(*)::int` })
      .from(playerTags)
      .where(gte(playerTags.createdAt, sevenDaysAgo))
      .groupBy(playerTags.tagId)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    const result: TrendingTag[] = [];
    for (const row of rows) {
      const [tag] = await db.select().from(tags).where(eq(tags.id, row.tagId));
      if (tag) result.push({ tag, count: row.count });
    }
    return result;
  }

  async getPlayerTopTags(playerId: string, limit = 3): Promise<PlayerTopTag[]> {
    const rows = await db
      .select({ tagId: playerTags.tagId, count: sql<number>`count(*)::int` })
      .from(playerTags)
      .where(eq(playerTags.taggedPlayerId, playerId))
      .groupBy(playerTags.tagId)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    const result: PlayerTopTag[] = [];
    for (const row of rows) {
      const [tag] = await db.select().from(tags).where(eq(tags.id, row.tagId));
      if (tag) result.push({ tag, count: row.count });
    }
    return result;
  }

  async getPlayersWithTag(tagId: string, limit = 10): Promise<Array<{ player: Player; count: number }>> {
    const rows = await db
      .select({ playerId: playerTags.taggedPlayerId, count: sql<number>`count(*)::int` })
      .from(playerTags)
      .where(eq(playerTags.tagId, tagId))
      .groupBy(playerTags.taggedPlayerId)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    const result: Array<{ player: Player; count: number }> = [];
    for (const row of rows) {
      const [player] = await db.select().from(players).where(eq(players.id, row.playerId));
      if (player) result.push({ player: addSkidToPlayer(player), count: row.count });
    }
    return result;
  }

  async createPlayerTags(entries: InsertPlayerTag[]): Promise<PlayerTag[]> {
    if (entries.length === 0) return [];
    const inserted = await db
      .insert(playerTags)
      .values(entries.map(e => ({ ...e, id: randomUUID() })))
      .returning();
    return inserted;
  }

  async getPlayerTagsForGame(gameResultId: string, taggedByPlayerId: string): Promise<PlayerTag[]> {
    return db.select().from(playerTags).where(
      and(
        eq(playerTags.gameResultId, gameResultId),
        eq(playerTags.taggedByPlayerId, taggedByPlayerId)
      )
    );
  }

  async getTaggedGameIds(taggedByPlayerId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ gameResultId: playerTags.gameResultId })
      .from(playerTags)
      .where(eq(playerTags.taggedByPlayerId, taggedByPlayerId));
    return rows.map(r => r.gameResultId);
  }

  async getGameParticipantInfo(gameResultId: string): Promise<GameParticipantInfo[]> {
    const rows = await db
      .select({
        id: players.id,
        name: players.name,
        team: gameParticipants.team,
      })
      .from(gameParticipants)
      .innerJoin(players, eq(gameParticipants.playerId, players.id))
      .where(eq(gameParticipants.gameId, gameResultId));
    return rows;
  }

  async getAllPlayersTopTag(): Promise<PlayerTopTagEntry[]> {
    // Single query: DISTINCT ON gets highest-count tag per player, joined with tags table
    const rows = await db.execute<{
      player_id: string;
      tag_id: string;
      cnt: number;
      tag_label: string;
      tag_emoji: string;
      tag_category: string;
    }>(sql`
      SELECT DISTINCT ON (pt.tagged_player_id)
        pt.tagged_player_id AS player_id,
        pt.tag_id,
        count(*)::int AS cnt,
        t.label AS tag_label,
        t.emoji AS tag_emoji,
        t.category AS tag_category
      FROM player_tags pt
      JOIN tags t ON t.id = pt.tag_id
      GROUP BY pt.tagged_player_id, pt.tag_id, t.label, t.emoji, t.category
      ORDER BY pt.tagged_player_id, cnt DESC
    `);

    return rows.rows.map(r => ({
      playerId: r.player_id,
      tag: { id: r.tag_id, label: r.tag_label, emoji: r.tag_emoji, category: r.tag_category } as Tag,
      count: Number(r.cnt),
    }));
  }

  async getCommunitySpotlight(limit = 5): Promise<CommunitySpotlightEntry[]> {
    // Single query: trending tags this week + top player per tag within the same window
    const rows = await db.execute<{
      tag_id: string;
      weekly_count: number;
      tag_label: string;
      tag_emoji: string;
      tag_category: string;
      top_player_id: string;
      top_player_name: string;
      top_player_level: string;
      top_player_skill_score: number;
      top_player_shuttle_iq_id: string | null;
      top_player_photo_url: string | null;
    }>(sql`
      WITH weekly AS (
        SELECT tag_id, tagged_player_id, count(*)::int AS cnt
        FROM player_tags
        WHERE created_at >= now() - interval '7 days'
        GROUP BY tag_id, tagged_player_id
      ),
      tag_totals AS (
        SELECT tag_id, sum(cnt)::int AS weekly_count
        FROM weekly
        GROUP BY tag_id
        ORDER BY weekly_count DESC
        LIMIT ${limit}
      ),
      top_players AS (
        SELECT DISTINCT ON (w.tag_id)
          w.tag_id,
          w.tagged_player_id AS top_player_id,
          w.cnt AS top_cnt
        FROM weekly w
        JOIN tag_totals tt ON tt.tag_id = w.tag_id
        ORDER BY w.tag_id, w.cnt DESC
      )
      SELECT
        tt.tag_id,
        tt.weekly_count,
        t.label AS tag_label,
        t.emoji AS tag_emoji,
        t.category AS tag_category,
        p.id AS top_player_id,
        p.name AS top_player_name,
        p.level AS top_player_level,
        p.skill_score AS top_player_skill_score,
        p.shuttle_iq_id AS top_player_shuttle_iq_id,
        mu.photo_url AS top_player_photo_url
      FROM tag_totals tt
      JOIN tags t ON t.id = tt.tag_id
      JOIN top_players tp ON tp.tag_id = tt.tag_id
      JOIN players p ON p.id = tp.top_player_id
      LEFT JOIN marketplace_users mu ON mu.linked_player_id = p.id
      ORDER BY tt.weekly_count DESC
    `);

    return rows.rows.map(r => ({
      tag: { id: r.tag_id, label: r.tag_label, emoji: r.tag_emoji, category: r.tag_category } as Tag,
      count: Number(r.weekly_count),
      topPlayer: {
        id: r.top_player_id,
        name: r.top_player_name,
        level: r.top_player_level,
        skillScore: Number(r.top_player_skill_score),
        shuttleIqId: r.top_player_shuttle_iq_id,
        photoUrl: r.top_player_photo_url,
      },
    }));
  }

  async getRecentReceivedTags(taggedPlayerId: string, limit = 5): Promise<ReceivedTagEntry[]> {
    // Single joined query — avoids N+1 lookups per received tag
    const rows = await db.execute<{
      tagger_name: string;
      tag_id: string;
      tag_label: string;
      tag_emoji: string;
      tag_category: string;
      venue_name: string | null;
      created_at: string;
    }>(sql`
      SELECT
        tagger.name AS tagger_name,
        t.id AS tag_id,
        t.label AS tag_label,
        t.emoji AS tag_emoji,
        t.category AS tag_category,
        s.venue_name AS venue_name,
        pt.created_at
      FROM player_tags pt
      JOIN tags t ON t.id = pt.tag_id
      JOIN players tagger ON tagger.id = pt.tagged_by_player_id
      LEFT JOIN game_results gr ON gr.id = pt.game_result_id
      LEFT JOIN sessions s ON s.id = gr.session_id
      WHERE pt.tagged_player_id = ${taggedPlayerId}
      ORDER BY pt.created_at DESC
      LIMIT ${limit}
    `);

    return rows.rows.map(r => ({
      taggerInitial: r.tagger_name.charAt(0).toUpperCase(),
      tag: { id: r.tag_id, label: r.tag_label, emoji: r.tag_emoji, category: r.tag_category } as Tag,
      sessionName: r.venue_name ?? 'a session',
      createdAt: r.created_at,
    }));
  }

  async getTagCountsForTargets(
    targetPlayerIds: string[],
    tagIds: string[]
  ): Promise<TagCountResult[]> {
    if (targetPlayerIds.length === 0 || tagIds.length === 0) return [];
    // Single batch query — only for the submitted player+tag pairs
    const rows = await db
      .select({
        playerId: playerTags.taggedPlayerId,
        tagId: playerTags.tagId,
        newCount: sql<number>`count(*)::int`,
      })
      .from(playerTags)
      .where(
        and(
          inArray(playerTags.taggedPlayerId, targetPlayerIds),
          inArray(playerTags.tagId, tagIds)
        )
      )
      .groupBy(playerTags.taggedPlayerId, playerTags.tagId);
    return rows.map(r => ({ playerId: r.playerId, tagId: r.tagId, newCount: Number(r.newCount) }));
  }

  async getPublicAnalytics({ sessionId, from, to }: { sessionId?: string; from?: Date; to?: Date }) {
    // Build booking-level conditions (date range applies to booking creation time)
    const bookingConditions: SQL[] = [];
    if (sessionId) bookingConditions.push(eq(bookings.sessionId, sessionId));
    if (from) bookingConditions.push(gte(bookings.createdAt, from));
    if (to) {
      // Advance one day so `to=YYYY-MM-DD` is inclusive for that calendar day
      const exclusiveTo = new Date(to);
      exclusiveTo.setUTCDate(exclusiveTo.getUTCDate() + 1);
      bookingConditions.push(lt(bookings.createdAt, exclusiveTo));
    }

    // Fetch all bookings that match the filters
    const bookingRows = await db
      .select({
        id: bookings.id,
        sessionId: bookings.sessionId,
        status: bookings.status,
        paymentMethod: bookings.paymentMethod,
        amountAed: bookings.amountAed,
        cashPaid: bookings.cashPaid,
        spotsBooked: bookings.spotsBooked,
        lateFeeApplied: bookings.lateFeeApplied,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .where(bookingConditions.length > 0 ? and(...bookingConditions) : undefined)
      .orderBy(asc(bookings.createdAt));

    // Fetch all bookable sessions (scoped by sessionId filter when provided)
    const sessionRows = await db
      .select({
        id: bookableSessions.id,
        title: bookableSessions.title,
        date: bookableSessions.date,
        startTime: bookableSessions.startTime,
        endTime: bookableSessions.endTime,
        venueName: bookableSessions.venueName,
        priceAed: bookableSessions.priceAed,
        capacity: bookableSessions.capacity,
      })
      .from(bookableSessions)
      .where(sessionId ? eq(bookableSessions.id, sessionId) : undefined)
      .orderBy(asc(bookableSessions.date));

    type BookingRow = typeof bookingRows[0];

    const isActive = (b: BookingRow) => ['confirmed', 'attended'].includes(b.status);
    const confirmed = bookingRows.filter(isActive);
    const waitlisted = bookingRows.filter(b => b.status === 'waitlisted');
    const cancelled = bookingRows.filter(b => b.status === 'cancelled');

    const cardBookings = confirmed.filter(b => b.paymentMethod === 'ziina');
    const cashBookings = confirmed.filter(b => b.paymentMethod === 'cash');
    const cashPaid = cashBookings.filter(b => b.cashPaid);
    const cashPending = cashBookings.filter(b => !b.cashPaid);

    const sumField = (arr: BookingRow[], field: 'amountAed' | 'spotsBooked') =>
      arr.reduce((s, b) => s + b[field], 0);

    // Build booking map keyed by sessionId for the per-session breakdown
    const bookingsBySession = new Map<string, BookingRow[]>();
    for (const b of bookingRows) {
      const list = bookingsBySession.get(b.sessionId) ?? [];
      list.push(b);
      bookingsBySession.set(b.sessionId, list);
    }

    // Per-session breakdown — includes ALL bookable sessions, even those with zero bookings
    const sessionBreakdowns = sessionRows.map(s => {
      const bkgs = bookingsBySession.get(s.id) ?? [];
      const conf = bkgs.filter(isActive);
      const wait = bkgs.filter(b => b.status === 'waitlisted');
      const canc = bkgs.filter(b => b.status === 'cancelled');
      return {
        id: s.id,
        title: s.title,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        venue: s.venueName,
        pricePerSpotAed: s.priceAed,
        capacity: s.capacity,
        confirmed: {
          bookings: conf.length,
          spots: sumField(conf, 'spotsBooked'),
          revenueAed: sumField(conf, 'amountAed'),
          collectedAed:
            sumField(conf.filter(b => b.paymentMethod === 'ziina'), 'amountAed') +
            sumField(conf.filter(b => b.paymentMethod === 'cash' && b.cashPaid), 'amountAed'),
          pendingCashAed: sumField(conf.filter(b => b.paymentMethod === 'cash' && !b.cashPaid), 'amountAed'),
        },
        waitlisted: {
          bookings: wait.length,
          spots: sumField(wait, 'spotsBooked'),
        },
        cancelled: {
          bookings: canc.length,
          spots: sumField(canc, 'spotsBooked'),
          lateFeesAed: sumField(canc.filter(b => b.lateFeeApplied), 'amountAed'),
        },
      };
    });

    // Monthly summary (by booking creation month, confirmed bookings only)
    const monthMap = new Map<string, BookingRow[]>();
    for (const b of confirmed) {
      const m = b.createdAt.toISOString().substring(0, 7);
      const list = monthMap.get(m) ?? [];
      list.push(b);
      monthMap.set(m, list);
    }
    const monthly = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bkgs]) => ({
        month,
        confirmedBookings: bkgs.length,
        totalSpotsBooked: sumField(bkgs, 'spotsBooked'),
        revenueChargedAed: sumField(bkgs, 'amountAed'),
        revenueCollectedAed:
          sumField(bkgs.filter(b => b.paymentMethod === 'ziina'), 'amountAed') +
          sumField(bkgs.filter(b => b.paymentMethod === 'cash' && b.cashPaid), 'amountAed'),
        revenuePendingCashAed: sumField(bkgs.filter(b => b.paymentMethod === 'cash' && !b.cashPaid), 'amountAed'),
      }));

    return {
      generatedAt: new Date().toISOString(),
      filters: {
        sessionId: sessionId ?? null,
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
      },
      totals: {
        confirmedBookings: confirmed.length,
        totalSpotsBooked: sumField(confirmed, 'spotsBooked'),
        revenueChargedAed: sumField(confirmed, 'amountAed'),
        revenueCollectedAed: sumField(cardBookings, 'amountAed') + sumField(cashPaid, 'amountAed'),
        revenuePendingCashAed: sumField(cashPending, 'amountAed'),
        cancelledBookings: cancelled.length,
        lateFeesRetainedAed: sumField(cancelled.filter(b => b.lateFeeApplied), 'amountAed'),
        waitlistedBookings: waitlisted.length,
        byPaymentMethod: {
          card: {
            bookings: cardBookings.length,
            spotsBooked: sumField(cardBookings, 'spotsBooked'),
            amountAed: sumField(cardBookings, 'amountAed'),
          },
          cash: {
            bookings: cashBookings.length,
            spotsBooked: sumField(cashBookings, 'spotsBooked'),
            amountAed: sumField(cashBookings, 'amountAed'),
            collectedAed: sumField(cashPaid, 'amountAed'),
            pendingAed: sumField(cashPending, 'amountAed'),
          },
        },
      },
      sessions: sessionBreakdowns,
      monthly,
    };
  }

  // ─── Finance / Accounting ─────────────────────────────────────────────────

  async getAllExpenseCategories(): Promise<ExpenseCategory[]> {
    return db.select().from(expenseCategories).orderBy(asc(expenseCategories.name));
  }

  async createExpenseCategory(data: InsertExpenseCategory): Promise<ExpenseCategory> {
    const id = randomUUID();
    const [row] = await db.insert(expenseCategories).values({ id, ...data }).returning();
    return row;
  }

  async updateExpenseCategory(id: string, updates: Partial<ExpenseCategory>): Promise<ExpenseCategory | undefined> {
    const [row] = await db.update(expenseCategories).set(updates).where(eq(expenseCategories.id, id)).returning();
    return row;
  }

  async deleteExpenseCategory(id: string): Promise<void> {
    await db.delete(expenseCategories).where(eq(expenseCategories.id, id));
  }

  async createExpense(data: InsertExpense): Promise<Expense> {
    const id = randomUUID();
    const now = new Date();
    const [row] = await db.insert(expenses).values({ id, ...data, createdAt: now, updatedAt: now }).returning();
    return row;
  }

  async getExpense(id: string): Promise<Expense | undefined> {
    const [row] = await db.select().from(expenses).where(eq(expenses.id, id));
    return row;
  }

  async getAllExpenses(filters?: { from?: Date; to?: Date; categoryId?: string; paidBy?: string }): Promise<ExpenseWithCategory[]> {
    const conditions: SQL[] = [];
    if (filters?.from) conditions.push(gte(expenses.date, filters.from));
    if (filters?.to) {
      const exclusiveTo = new Date(filters.to);
      exclusiveTo.setUTCDate(exclusiveTo.getUTCDate() + 1);
      conditions.push(lt(expenses.date, exclusiveTo));
    }
    if (filters?.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
    if (filters?.paidBy) conditions.push(eq(expenses.paidBy, filters.paidBy));

    const rows = await db
      .select({
        id: expenses.id,
        categoryId: expenses.categoryId,
        amountAed: expenses.amountAed,
        description: expenses.description,
        vendor: expenses.vendor,
        paidBy: expenses.paidBy,
        date: expenses.date,
        notes: expenses.notes,
        createdAt: expenses.createdAt,
        updatedAt: expenses.updatedAt,
        categoryName: expenseCategories.name,
        categoryColor: expenseCategories.color,
        categoryIcon: expenseCategories.icon,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(expenses.date));

    return rows;
  }

  async updateExpense(id: string, updates: Partial<Pick<Expense, 'categoryId' | 'amountAed' | 'description' | 'vendor' | 'paidBy' | 'date' | 'notes'>>): Promise<Expense | undefined> {
    const [row] = await db
      .update(expenses)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(expenses.id, id))
      .returning();
    return row;
  }

  async deleteExpense(id: string): Promise<void> {
    await db.delete(expenses).where(eq(expenses.id, id));
  }

  async getFinanceSummary(from: Date, to: Date): Promise<FinanceSummary> {
    // Advance `to` to be end-of-day inclusive
    const exclusiveTo = new Date(to);
    exclusiveTo.setUTCDate(exclusiveTo.getUTCDate() + 1);

    // ── Revenue from bookings ──────────────────────────────────────────────
    const bookingRows = await db
      .select({
        status: bookings.status,
        paymentMethod: bookings.paymentMethod,
        amountAed: bookings.amountAed,
        cashPaid: bookings.cashPaid,
        lateFeeApplied: bookings.lateFeeApplied,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .where(and(gte(bookings.createdAt, from), lt(bookings.createdAt, exclusiveTo)));

    type BRow = typeof bookingRows[0];
    const isActive = (b: BRow) => ['confirmed', 'attended'].includes(b.status);
    const confirmed = bookingRows.filter(isActive);
    const cancelled = bookingRows.filter(b => b.status === 'cancelled');
    const cardRows = confirmed.filter(b => b.paymentMethod === 'ziina');
    const cashPaidRows = confirmed.filter(b => b.paymentMethod === 'cash' && b.cashPaid);
    const sumAed = (arr: BRow[]) => arr.reduce((s, b) => s + b.amountAed, 0);

    const chargedAed = sumAed(confirmed);
    const collectedAed = sumAed(cardRows) + sumAed(cashPaidRows);
    const pendingCashAed = sumAed(confirmed.filter(b => b.paymentMethod === 'cash' && !b.cashPaid));
    const lateFeesAed = sumAed(cancelled.filter(b => b.lateFeeApplied));

    // ── Expenses ──────────────────────────────────────────────────────────
    const expenseRows = await db
      .select({
        id: expenses.id,
        categoryId: expenses.categoryId,
        amountAed: expenses.amountAed,
        date: expenses.date,
        paidBy: expenses.paidBy,
        categoryName: expenseCategories.name,
        categoryColor: expenseCategories.color,
        categoryIcon: expenseCategories.icon,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(and(gte(expenses.date, from), lt(expenses.date, exclusiveTo)));

    const totalExpensesAed = expenseRows.reduce((s, e) => s + e.amountAed, 0);

    // Aggregate by category
    const catMap = new Map<string, { id: string; name: string; color: string; icon: string; total: number; count: number }>();
    for (const e of expenseRows) {
      const existing = catMap.get(e.categoryId);
      if (existing) {
        existing.total += e.amountAed;
        existing.count += 1;
      } else {
        catMap.set(e.categoryId, { id: e.categoryId, name: e.categoryName, color: e.categoryColor, icon: e.categoryIcon, total: e.amountAed, count: 1 });
      }
    }
    const byCategory = Array.from(catMap.values())
      .map(c => ({ id: c.id, name: c.name, color: c.color, icon: c.icon, totalAed: c.total, count: c.count }))
      .sort((a, b) => b.totalAed - a.totalAed);

    // Aggregate by Paid By person
    const paidByMap = new Map<string, { paidBy: string | null; total: number; count: number }>();
    for (const e of expenseRows) {
      const key = e.paidBy ?? '__unassigned__';
      const existing = paidByMap.get(key);
      if (existing) {
        existing.total += e.amountAed;
        existing.count += 1;
      } else {
        paidByMap.set(key, { paidBy: e.paidBy ?? null, total: e.amountAed, count: 1 });
      }
    }
    const byPaidBy = Array.from(paidByMap.values())
      .map(p => ({
        paidBy: p.paidBy,
        label: p.paidBy ?? 'Unassigned',
        totalAed: p.total,
        count: p.count,
      }))
      .sort((a, b) => b.totalAed - a.totalAed);

    // ── Monthly rows ──────────────────────────────────────────────────────
    const revenueByMonth = new Map<string, number>();
    for (const b of confirmed) {
      const m = b.createdAt.toISOString().substring(0, 7);
      const amt = b.paymentMethod === 'ziina' ? b.amountAed : (b.cashPaid ? b.amountAed : 0);
      revenueByMonth.set(m, (revenueByMonth.get(m) ?? 0) + amt);
    }
    const expensesByMonth = new Map<string, number>();
    for (const e of expenseRows) {
      const m = e.date.toISOString().substring(0, 7);
      expensesByMonth.set(m, (expensesByMonth.get(m) ?? 0) + e.amountAed);
    }
    const allMonths = new Set([...Array.from(revenueByMonth.keys()), ...Array.from(expensesByMonth.keys())]);
    const monthlyRows = Array.from(allMonths)
      .sort()
      .map(month => {
        const rev = revenueByMonth.get(month) ?? 0;
        const exp = expensesByMonth.get(month) ?? 0;
        return { month, revenueCollectedAed: rev, expensesAed: exp, netAed: rev - exp };
      });

    return {
      revenue: { chargedAed, collectedAed, pendingCashAed, lateFeesAed },
      expenses: { totalAed: totalExpensesAed, byCategory, byPaidBy },
      netProfitAed: collectedAed - totalExpensesAed,
      monthlyRows,
    };
  }

  // ─── Tag Suggestions ──────────────────────────────────────────────────────

  async createTagSuggestion(data: InsertTagSuggestion): Promise<TagSuggestion> {
    const id = randomUUID();
    const [row] = await db.insert(tagSuggestions).values({ ...data, id }).returning();
    return row;
  }

  async getTagSuggestions(status: 'pending' | 'approved' | 'rejected', viewerPlayerId?: string): Promise<TagSuggestionWithVote[]> {
    const rows = await db
      .select()
      .from(tagSuggestions)
      .where(eq(tagSuggestions.status, status))
      .orderBy(desc(tagSuggestions.voteCount), desc(tagSuggestions.createdAt));

    if (rows.length === 0) return [];

    const suggestionIds = rows.map(r => r.id);

    // Get player names for suggesters
    const suggesterIds = [...new Set(rows.map(r => r.suggestedByPlayerId))];
    const playerRows = await db
      .select({ id: players.id, name: players.name })
      .from(players)
      .where(inArray(players.id, suggesterIds));
    const playerMap = new Map(playerRows.map(p => [p.id, p.name]));

    // Get votes by viewer (if provided)
    const votedSet = new Set<string>();
    if (viewerPlayerId) {
      const votes = await db
        .select({ suggestionId: tagSuggestionVotes.suggestionId })
        .from(tagSuggestionVotes)
        .where(
          and(
            inArray(tagSuggestionVotes.suggestionId, suggestionIds),
            eq(tagSuggestionVotes.votedByPlayerId, viewerPlayerId)
          )
        );
      for (const v of votes) votedSet.add(v.suggestionId);
    }

    return rows.map(r => ({
      ...r,
      hasVoted: votedSet.has(r.id),
      suggestedByPlayerName: playerMap.get(r.suggestedByPlayerId) ?? 'Unknown',
    }));
  }

  async getTagSuggestionsByPlayer(playerId: string): Promise<TagSuggestion[]> {
    return await db
      .select()
      .from(tagSuggestions)
      .where(eq(tagSuggestions.suggestedByPlayerId, playerId))
      .orderBy(desc(tagSuggestions.createdAt));
  }

  private async _promoteTagSuggestion(suggestion: TagSuggestion): Promise<void> {
    // Check the tag doesn't already exist (dedup by label, case-insensitive)
    const existing = await db
      .select({ id: tags.id })
      .from(tags)
      .where(sql`lower(${tags.label}) = lower(${suggestion.label})`);
    if (existing.length === 0) {
      await db.insert(tags).values({
        id: randomUUID(),
        label: suggestion.label,
        emoji: suggestion.emoji,
        category: suggestion.category,
        isActive: true,
      });
    }
    const now = new Date();
    await db
      .update(tagSuggestions)
      .set({ status: 'approved', reviewedAt: now, promotedAt: now })
      .where(eq(tagSuggestions.id, suggestion.id));
  }

  async voteTagSuggestion(suggestionId: string, playerId: string): Promise<{ alreadyVoted: boolean; ownSuggestion: boolean; notPending: boolean; newCount: number }> {
    // Fetch suggestion first to validate
    const [suggestion] = await db
      .select()
      .from(tagSuggestions)
      .where(eq(tagSuggestions.id, suggestionId));

    if (!suggestion) return { alreadyVoted: false, ownSuggestion: false, notPending: true, newCount: 0 };
    if (suggestion.status !== 'pending') return { alreadyVoted: false, ownSuggestion: false, notPending: true, newCount: suggestion.voteCount };
    if (suggestion.suggestedByPlayerId === playerId) return { alreadyVoted: false, ownSuggestion: true, notPending: false, newCount: suggestion.voteCount };

    // Check if already voted
    const existing = await db
      .select()
      .from(tagSuggestionVotes)
      .where(
        and(
          eq(tagSuggestionVotes.suggestionId, suggestionId),
          eq(tagSuggestionVotes.votedByPlayerId, playerId)
        )
      );
    if (existing.length > 0) {
      return { alreadyVoted: true, ownSuggestion: false, notPending: false, newCount: suggestion.voteCount };
    }

    await db.insert(tagSuggestionVotes).values({ id: randomUUID(), suggestionId, votedByPlayerId: playerId });
    const [updated] = await db
      .update(tagSuggestions)
      .set({ voteCount: sql`${tagSuggestions.voteCount} + 1` })
      .where(eq(tagSuggestions.id, suggestionId))
      .returning();

    const newCount = updated?.voteCount ?? 0;

    // Auto-promote if threshold reached
    const VOTE_THRESHOLD = 10;
    if (updated && newCount >= VOTE_THRESHOLD && updated.status === 'pending') {
      await this._promoteTagSuggestion(updated);
    }

    return { alreadyVoted: false, ownSuggestion: false, notPending: false, newCount };
  }

  async unvoteTagSuggestion(suggestionId: string, playerId: string): Promise<{ newCount: number }> {
    await db
      .delete(tagSuggestionVotes)
      .where(
        and(
          eq(tagSuggestionVotes.suggestionId, suggestionId),
          eq(tagSuggestionVotes.votedByPlayerId, playerId)
        )
      );
    const [updated] = await db
      .update(tagSuggestions)
      .set({ voteCount: sql`GREATEST(${tagSuggestions.voteCount} - 1, 0)` })
      .where(eq(tagSuggestions.id, suggestionId))
      .returning({ voteCount: tagSuggestions.voteCount });
    return { newCount: updated?.voteCount ?? 0 };
  }

  async reviewTagSuggestion(suggestionId: string, status: 'approved' | 'rejected', adminNote?: string): Promise<TagSuggestion | undefined> {
    if (status === 'approved') {
      const [suggestion] = await db
        .select()
        .from(tagSuggestions)
        .where(eq(tagSuggestions.id, suggestionId));
      if (suggestion) {
        if (adminNote !== undefined) {
          await db.update(tagSuggestions).set({ adminNote }).where(eq(tagSuggestions.id, suggestionId));
        }
        await this._promoteTagSuggestion(suggestion);
        const [row] = await db.select().from(tagSuggestions).where(eq(tagSuggestions.id, suggestionId));
        return row ?? undefined;
      }
    }
    const updates: Partial<TagSuggestion> = {
      status,
      reviewedAt: new Date(),
      ...(adminNote !== undefined ? { adminNote } : {}),
    };
    const [row] = await db
      .update(tagSuggestions)
      .set(updates)
      .where(eq(tagSuggestions.id, suggestionId))
      .returning();
    return row ?? undefined;
  }

  // ─── Blog operations ──────────────────────────────────────────────────────────

  async createBlogPost(data: InsertBlogPost): Promise<BlogPost> {
    const id = randomUUID();
    const [row] = await db
      .insert(blogPosts)
      .values({ ...data, id })
      .returning();
    return row;
  }

  async getBlogPost(id: string): Promise<BlogPost | undefined> {
    const [row] = await db.select().from(blogPosts).where(eq(blogPosts.id, id));
    return row ?? undefined;
  }

  async getBlogPostBySlug(slug: string): Promise<BlogPost | undefined> {
    const [row] = await db.select().from(blogPosts).where(eq(blogPosts.slug, slug));
    return row ?? undefined;
  }

  async getAllBlogPosts(includeUnpublished = false): Promise<BlogPost[]> {
    const conditions: SQL[] = [];
    if (!includeUnpublished) {
      conditions.push(eq(blogPosts.status, "published"));
    }
    return db
      .select()
      .from(blogPosts)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.createdAt));
  }

  async updateBlogPost(id: string, updates: Partial<BlogPost>): Promise<BlogPost | undefined> {
    const [row] = await db
      .update(blogPosts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(blogPosts.id, id))
      .returning();
    return row ?? undefined;
  }

  async deleteBlogPost(id: string): Promise<boolean> {
    const result = await db.delete(blogPosts).where(eq(blogPosts.id, id)).returning();
    return result.length > 0;
  }

  // ─── Referral operations ───────────────────────────────────────────────────

  async createReferral(data: InsertReferral): Promise<Referral> {
    const id = randomUUID();
    const [row] = await db
      .insert(referrals)
      .values({ ...data, id })
      .returning();
    return row;
  }

  async getReferral(id: string): Promise<Referral | undefined> {
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    return row ?? undefined;
  }

  async getReferralByRefereeUserId(refereeUserId: string): Promise<Referral | undefined> {
    const [row] = await db
      .select()
      .from(referrals)
      .where(eq(referrals.refereeUserId, refereeUserId));
    return row ?? undefined;
  }

  async getReferralByRefereePlayerId(refereePlayerId: string): Promise<Referral | undefined> {
    const [row] = await db
      .select()
      .from(referrals)
      .where(eq(referrals.refereePlayerId, refereePlayerId));
    return row ?? undefined;
  }

  async getReferralsByReferrerId(referrerId: string): Promise<(Referral & { refereeName: string | null })[]> {
    const rows = await db
      .select({
        id: referrals.id,
        referrerId: referrals.referrerId,
        refereeUserId: referrals.refereeUserId,
        refereePlayerId: referrals.refereePlayerId,
        status: referrals.status,
        completedAt: referrals.completedAt,
        createdAt: referrals.createdAt,
        refereeName: marketplaceUsers.name,
      })
      .from(referrals)
      .leftJoin(marketplaceUsers, eq(referrals.refereeUserId, marketplaceUsers.id))
      .where(eq(referrals.referrerId, referrerId))
      .orderBy(desc(referrals.createdAt));
    return rows.map(r => ({ ...r, refereeName: r.refereeName ?? null }));
  }

  async getCompletedReferralCount(referrerId: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(referrals)
      .where(and(eq(referrals.referrerId, referrerId), eq(referrals.status, 'completed')));
    return result?.count ?? 0;
  }

  async getAllReferrals(): Promise<(Referral & { referrerName: string; refereeEmail: string; referralCode: string | null; ambassadorStatus: boolean; jerseyDispatched: boolean })[]> {
    const rows = await db
      .select({
        id: referrals.id,
        referrerId: referrals.referrerId,
        refereeUserId: referrals.refereeUserId,
        refereePlayerId: referrals.refereePlayerId,
        status: referrals.status,
        completedAt: referrals.completedAt,
        createdAt: referrals.createdAt,
        referrerName: players.name,
        refereeEmail: marketplaceUsers.email,
        referralCode: players.referralCode,
        ambassadorStatus: players.ambassadorStatus,
        jerseyDispatched: players.jerseyDispatched,
      })
      .from(referrals)
      .leftJoin(players, eq(referrals.referrerId, players.id))
      .leftJoin(marketplaceUsers, eq(referrals.refereeUserId, marketplaceUsers.id))
      .orderBy(desc(referrals.createdAt));
    return rows.map(r => ({
      ...r,
      referrerName: r.referrerName ?? 'Unknown',
      refereeEmail: r.refereeEmail ?? 'Unknown',
      referralCode: r.referralCode ?? null,
      ambassadorStatus: r.ambassadorStatus ?? false,
      jerseyDispatched: r.jerseyDispatched ?? false,
    }));
  }

  async updateReferral(id: string, updates: Partial<Referral>): Promise<Referral | undefined> {
    const [row] = await db
      .update(referrals)
      .set(updates)
      .where(eq(referrals.id, id))
      .returning();
    return row ?? undefined;
  }

  async getReferralLeaderboard(limit = 10): Promise<{ playerId: string; playerName: string; referralCode: string | null; completedCount: number; ambassadorStatus: boolean; photoUrl: string | null }[]> {
    const rows = await db
      .select({
        playerId: players.id,
        playerName: players.name,
        referralCode: players.referralCode,
        completedCount: sql<number>`count(${referrals.id})::int`,
        ambassadorStatus: players.ambassadorStatus,
        photoUrl: marketplaceUsers.photoUrl,
      })
      .from(referrals)
      .innerJoin(players, eq(referrals.referrerId, players.id))
      .leftJoin(marketplaceUsers, eq(marketplaceUsers.linkedPlayerId, players.id))
      .where(eq(referrals.status, 'completed'))
      .groupBy(players.id, players.name, players.referralCode, players.ambassadorStatus, marketplaceUsers.photoUrl)
      .orderBy(desc(sql`count(${referrals.id})`))
      .limit(limit);
    return rows;
  }

  async getPlayerByReferralCode(code: string): Promise<Player | undefined> {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.referralCode, code.toUpperCase()));
    return player ? addSkidToPlayer(player) : undefined;
  }

  async backfillReferralCodes(): Promise<number> {
    const playersWithoutCodes = await db
      .select()
      .from(players)
      .where(sql`${players.referralCode} IS NULL`);
    let count = 0;
    for (const p of playersWithoutCodes) {
      const code = generateReferralCode(p.name, p.shuttleIqId);
      try {
        await db.update(players).set({ referralCode: code }).where(eq(players.id, p.id));
        count++;
      } catch {
        const fallback = generateReferralCode(p.name, `SIQ-${Date.now() % 99999}`);
        await db.update(players).set({ referralCode: fallback }).where(eq(players.id, p.id));
        count++;
      }
    }
    return count;
  }

  async createPaymentResumeToken(input: { marketplaceUserId: string; bookingId: string; tokenHash: string; expiresAt: Date }): Promise<PaymentResumeToken> {
    const [row] = await db
      .insert(paymentResumeTokens)
      .values({
        id: randomUUID(),
        marketplaceUserId: input.marketplaceUserId,
        bookingId: input.bookingId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning();
    return row;
  }

  async consumePaymentResumeToken(tokenHash: string): Promise<{ status: 'ok'; token: PaymentResumeToken } | { status: 'unknown' | 'expired' | 'used' }> {
    const [existing] = await db
      .select()
      .from(paymentResumeTokens)
      .where(eq(paymentResumeTokens.tokenHash, tokenHash))
      .limit(1);
    if (!existing) return { status: 'unknown' };
    if (existing.usedAt) return { status: 'used' };
    if (new Date() > existing.expiresAt) return { status: 'expired' };

    // Atomic single-use claim — only succeeds if used_at is still null.
    const [claimed] = await db
      .update(paymentResumeTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(paymentResumeTokens.id, existing.id),
        sql`${paymentResumeTokens.usedAt} IS NULL`,
      ))
      .returning();
    if (!claimed) return { status: 'used' };
    return { status: 'ok', token: claimed };
  }

  async deleteExpiredPaymentResumeTokens(): Promise<number> {
    const result = await db
      .delete(paymentResumeTokens)
      .where(sql`${paymentResumeTokens.usedAt} IS NOT NULL OR ${paymentResumeTokens.expiresAt} < NOW()`);
    return result.rowCount ?? 0;
  }

  // ─── Match suggestion operations ─────────────────────────────────────────
  async createMatchSuggestion(input: {
    sessionId: string;
    courtId: string;
    pendingUntil: Date | null;
    status?: 'pending' | 'queued';
    includesActivePlayers?: boolean;
    players: Array<{ playerId: string; team: number }>;
  }): Promise<MatchSuggestion> {
    if (input.players.length !== 4) {
      throw new Error(`createMatchSuggestion expects exactly 4 players, got ${input.players.length}`);
    }
    const uniqueIds = new Set(input.players.map(p => p.playerId));
    if (uniqueIds.size !== 4) {
      throw new Error(`createMatchSuggestion player IDs must be unique`);
    }
    const team1Count = input.players.filter(p => p.team === 1).length;
    const team2Count = input.players.filter(p => p.team === 2).length;
    if (team1Count !== 2 || team2Count !== 2) {
      throw new Error(`createMatchSuggestion expects 2v2 split, got ${team1Count}v${team2Count}`);
    }
    const status = input.status ?? 'pending';
    if (status === 'pending' && input.pendingUntil === null) {
      throw new Error(`createMatchSuggestion: pendingUntil is required for status='pending'`);
    }
    if (status === 'queued' && input.pendingUntil !== null) {
      throw new Error(`createMatchSuggestion: pendingUntil must be null for status='queued'`);
    }

    const id = randomUUID();
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(matchSuggestions)
        .values({
          id,
          sessionId: input.sessionId,
          courtId: input.courtId,
          pendingUntil: input.pendingUntil,
          status,
          includesActivePlayers: input.includesActivePlayers ?? false,
        })
        .returning();
      // courtId on the child rows is duplicated from the parent suggestion
      // so "which court is player X queued for" is a single-table read.
      await tx.insert(matchSuggestionPlayers).values(
        input.players.map(p => ({
          suggestionId: id,
          courtId: input.courtId,
          playerId: p.playerId,
          team: p.team,
        }))
      );
      return row;
    });
  }

  async getMatchSuggestion(id: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined> {
    const [row] = await db.select().from(matchSuggestions).where(eq(matchSuggestions.id, id)).limit(1);
    if (!row) return undefined;
    const playerRows = await db
      .select()
      .from(matchSuggestionPlayers)
      .where(eq(matchSuggestionPlayers.suggestionId, id));
    return { ...row, players: playerRows };
  }

  async getPendingMatchSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined> {
    // 'pending' = awaiting approval; 'approved' = approved but not yet
    // started. Both are "active" from the court's perspective.
    const [row] = await db
      .select()
      .from(matchSuggestions)
      .where(and(
        eq(matchSuggestions.courtId, courtId),
        inArray(matchSuggestions.status, ['pending', 'approved']),
      ))
      .orderBy(desc(matchSuggestions.suggestedAt))
      .limit(1);
    if (!row) return undefined;
    const playerRows = await db
      .select()
      .from(matchSuggestionPlayers)
      .where(eq(matchSuggestionPlayers.suggestionId, row.id));
    return { ...row, players: playerRows };
  }

  async getActiveMatchSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined> {
    // Same shape as getPendingMatchSuggestionForCourt but ALSO includes
    // 'playing'. Admin cancel-game / end-game need to find the live row
    // for the court regardless of where it sits in the lifecycle.
    const [row] = await db
      .select()
      .from(matchSuggestions)
      .where(and(
        eq(matchSuggestions.courtId, courtId),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing']),
      ))
      .orderBy(desc(matchSuggestions.suggestedAt))
      .limit(1);
    if (!row) return undefined;
    const playerRows = await db
      .select()
      .from(matchSuggestionPlayers)
      .where(eq(matchSuggestionPlayers.suggestionId, row.id));
    return { ...row, players: playerRows };
  }

  async replaceActiveSuggestionForAdminAssignment(input: {
    sessionId: string;
    courtId: string;
    pendingUntil: Date;
    approvedBy: string;
    players: Array<{ playerId: string; team: number }>;
  }): Promise<MatchSuggestion> {
    if (input.players.length !== 4) {
      throw new Error(`replaceActiveSuggestionForAdminAssignment expects exactly 4 players, got ${input.players.length}`);
    }
    const playerIds = input.players.map(p => p.playerId);
    const uniqueIds = new Set(playerIds);
    if (uniqueIds.size !== 4) {
      throw new Error(`replaceActiveSuggestionForAdminAssignment player IDs must be unique`);
    }
    const team1Count = input.players.filter(p => p.team === 1).length;
    const team2Count = input.players.filter(p => p.team === 2).length;
    if (team1Count !== 2 || team2Count !== 2) {
      throw new Error(`replaceActiveSuggestionForAdminAssignment expects 2v2 split, got ${team1Count}v${team2Count}`);
    }

    const newId = randomUUID();
    return await db.transaction(async (tx) => {
      // Step 1: collect IDs of any active suggestions tied to this court
      // OR involving any of these players. Two narrow queries are cheaper
      // (and easier to reason about) than a single OR'd join.
      // 'queued' is included so an admin assignment never leaves a stale
      // next-round lineup pointing at the same court or naming any of
      // the 4 newly-assigned players. Without this, the queued row
      // would silently linger and double-book players when the current
      // game ends.
      const byCourt = await tx
        .select({ id: matchSuggestions.id })
        .from(matchSuggestions)
        .where(and(
          eq(matchSuggestions.courtId, input.courtId),
          inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
        ));
      const byPlayer = await tx
        .select({ id: matchSuggestions.id })
        .from(matchSuggestionPlayers)
        .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
        .where(and(
          inArray(matchSuggestionPlayers.playerId, playerIds),
          inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
        ));
      const conflictIds = Array.from(new Set([
        ...byCourt.map(r => r.id),
        ...byPlayer.map(r => r.id),
      ]));

      // Step 2: dismiss conflicting suggestions so the player-facing view
      // can never observe two simultaneously-active rows for the same
      // court or player. We also bump pendingUntil to (now + 10 min) on
      // these rows so the /current-suggestion endpoint's recently-
      // dismissed fallback can detect them via a single column filter.
      // This re-purposes pendingUntil for dismissed rows (the sweep only
      // touches status='pending' rows so there's no semantic conflict)
      // and avoids a schema migration to add a dedicated dismissedAt
      // column. The 10-min window is generous enough for any reasonable
      // player polling cadence, including phones that briefly background.
      if (conflictIds.length > 0) {
        const dismissalWindowEnd = new Date(Date.now() + 10 * 60 * 1000);
        await tx
          .update(matchSuggestions)
          .set({ status: 'dismissed', pendingUntil: dismissalWindowEnd })
          .where(inArray(matchSuggestions.id, conflictIds));
      }

      // Step 3: insert the new 'playing' suggestion. We skip the 'pending'
      // → 'approved' → 'playing' lifecycle because the admin acted
      // directly on the court — there is nothing to approve.
      const [row] = await tx
        .insert(matchSuggestions)
        .values({
          id: newId,
          sessionId: input.sessionId,
          courtId: input.courtId,
          pendingUntil: input.pendingUntil,
          status: 'playing',
          approvedBy: input.approvedBy,
        })
        .returning();

      // Step 4: insert the 4 child rows. courtId is duplicated from the
      // parent for single-table hot-path lookups — see schema comment.
      await tx.insert(matchSuggestionPlayers).values(
        input.players.map(p => ({
          suggestionId: newId,
          courtId: input.courtId,
          playerId: p.playerId,
          team: p.team,
        }))
      );

      return row;
    });
  }

  async getCurrentSuggestionForPlayer(playerId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined> {
    // Singular: a player should be in at most one suggestion in any of
    // these statuses at a time (enforced by createMatchSuggestion plus
    // the queued orchestrator's de-dup pass). Child rows are preserved
    // for the suggestion's lifetime, so we filter active state via a
    // parent status check rather than relying on child-row presence.
    //
    // Priority order (highest first): playing > approved > pending > queued.
    // Implemented with a CASE expression in ORDER BY so the route layer
    // doesn't have to chain four separate queries. A waiting player who
    // appears in their own court's queued lineup AND is also the named
    // member of another court's queued lineup will still see only one
    // row (the most recent). A player who is currently playing will
    // never see a queued row for any other court — playing wins.
    const [row] = await db
      .select({
        id: matchSuggestions.id,
        sessionId: matchSuggestions.sessionId,
        courtId: matchSuggestions.courtId,
        suggestedAt: matchSuggestions.suggestedAt,
        pendingUntil: matchSuggestions.pendingUntil,
        status: matchSuggestions.status,
        approvedBy: matchSuggestions.approvedBy,
        includesActivePlayers: matchSuggestions.includesActivePlayers,
        createdAt: matchSuggestions.createdAt,
      })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestionPlayers.suggestionId, matchSuggestions.id))
      .innerJoin(sessions, eq(matchSuggestions.sessionId, sessions.id))
      .where(and(
        eq(matchSuggestionPlayers.playerId, playerId),
        inArray(matchSuggestions.status, ['playing', 'approved', 'pending', 'queued']),
        eq(sessions.status, 'active'),
      ))
      .orderBy(
        sql`CASE ${matchSuggestions.status}
              WHEN 'playing'  THEN 1
              WHEN 'approved' THEN 2
              WHEN 'pending'  THEN 3
              WHEN 'queued'   THEN 4
              ELSE 5
            END ASC`,
        desc(matchSuggestions.suggestedAt),
      )
      .limit(1);
    if (!row) return undefined;
    const playerRows = await db
      .select()
      .from(matchSuggestionPlayers)
      .where(eq(matchSuggestionPlayers.suggestionId, row.id));
    return { ...row, players: playerRows };
  }

  async listPastPendingMatchSuggestions(now: Date): Promise<MatchSuggestion[]> {
    // Belt-and-braces: status='pending' rows ALWAYS have pendingUntil set
    // (createMatchSuggestion enforces this), but the column is nullable to
    // support 'queued' rows. The explicit IS NOT NULL guard makes the
    // sweep robust against any future status that might also share this
    // table without a deadline column.
    return await db
      .select()
      .from(matchSuggestions)
      .where(and(
        eq(matchSuggestions.status, 'pending'),
        sql`${matchSuggestions.pendingUntil} IS NOT NULL`,
        lt(matchSuggestions.pendingUntil, now),
      ));
  }

  async updateMatchSuggestionStatus(
    id: string,
    status: string,
    approvedBy?: string | null,
  ): Promise<MatchSuggestion | undefined> {
    const updates: Partial<MatchSuggestion> = { status };
    if (approvedBy !== undefined) {
      updates.approvedBy = approvedBy;
    }
    const [row] = await db
      .update(matchSuggestions)
      .set(updates)
      .where(eq(matchSuggestions.id, id))
      .returning();
    return row;
  }

  // ─── Queued suggestion lifecycle helpers ─────────────────────────────────
  // Returns the most recent 'queued' suggestion for a court (with players),
  // if any. Used by the game-end transition to decide whether the next
  // round's lineup can be flipped to 'pending' immediately or needs to be
  // re-validated.
  async getQueuedSuggestionForCourt(courtId: string): Promise<(MatchSuggestion & { players: MatchSuggestionPlayer[] }) | undefined> {
    const [row] = await db
      .select()
      .from(matchSuggestions)
      .where(and(
        eq(matchSuggestions.courtId, courtId),
        eq(matchSuggestions.status, 'queued'),
      ))
      .orderBy(desc(matchSuggestions.suggestedAt))
      .limit(1);
    if (!row) return undefined;
    const playerRows = await db
      .select()
      .from(matchSuggestionPlayers)
      .where(eq(matchSuggestionPlayers.suggestionId, row.id));
    return { ...row, players: playerRows };
  }

  // Atomic CAS for queued → pending. Sets a fresh pendingUntil so the
  // 90s auto-approve window starts NOW, not when the queued row was
  // originally created. Returns undefined if the row is no longer queued
  // (e.g. dismissed by an admin reassign).
  async flipQueuedSuggestionToPending(
    suggestionId: string,
    pendingUntil: Date,
  ): Promise<MatchSuggestion | undefined> {
    const [row] = await db
      .update(matchSuggestions)
      .set({ status: 'pending', pendingUntil })
      .where(and(
        eq(matchSuggestions.id, suggestionId),
        eq(matchSuggestions.status, 'queued'),
      ))
      .returning();
    return row;
  }

  // Atomic CAS for queued → dismissed. Used when game-end verification
  // finds that one of the named active players is no longer eligible
  // (left the session, got reassigned by admin, etc.). The 10-min
  // dismissal-window pendingUntil mirrors the admin replace path so the
  // dismissed-fallback in /current-suggestion can find it briefly.
  async dismissQueuedSuggestion(suggestionId: string): Promise<MatchSuggestion | undefined> {
    const dismissalWindowEnd = new Date(Date.now() + 10 * 60 * 1000);
    const [row] = await db
      .update(matchSuggestions)
      .set({ status: 'dismissed', pendingUntil: dismissalWindowEnd })
      .where(and(
        eq(matchSuggestions.id, suggestionId),
        eq(matchSuggestions.status, 'queued'),
      ))
      .returning();
    return row;
  }

  // Atomic compare-and-set used by every code path that transitions a
  // match suggestion out of 'pending' (sweep, captain approve, captain
  // dismiss). Returns undefined when the row is no longer pending, so the
  // caller can skip duplicate notifications.
  async transitionPendingMatchSuggestion(
    id: string,
    nextStatus: string,
    approvedBy?: string | null,
  ): Promise<MatchSuggestion | undefined> {
    const updates: Partial<MatchSuggestion> = { status: nextStatus };
    if (approvedBy !== undefined) {
      updates.approvedBy = approvedBy;
    }
    const [row] = await db
      .update(matchSuggestions)
      .set(updates)
      .where(and(
        eq(matchSuggestions.id, id),
        eq(matchSuggestions.status, 'pending'),
      ))
      .returning();
    return row;
  }

  // Player-driven start-game CAS. The UPDATE … WHERE status='approved' is
  // atomic: when N players tap Start within the same poll window, exactly
  // one UPDATE returns a row and the rest see a no-op. The follow-up read
  // (only reached when our UPDATE returned nothing) tells us which case
  // we're in: 'playing' = the race winner already flipped it, anything
  // else = the row is no longer in a startable state and the caller
  // should surface a 4xx. We use a transaction so the UPDATE and the
  // disambiguating read see the same snapshot — without that, the row
  // could legitimately transition (e.g. admin cancelled) between the
  // two statements and produce a misleading 'not-startable' for what
  // was actually an 'already-started' race loss.
  async startApprovedSuggestion(suggestionId: string): Promise<
    | { result: 'started'; suggestion: MatchSuggestion }
    | { result: 'already-started'; suggestion: MatchSuggestion }
    | { result: 'not-startable'; suggestion: MatchSuggestion }
    | { result: 'not-found' }
  > {
    // The CAS approved → playing AND every downstream side effect (court
    // status, court_players roster, per-player status, queue removal) all
    // run inside a SINGLE transaction. Either the player visibly starts
    // the game and every dependent table reflects it, or nothing changed.
    // This matches the integrity contract of the admin assignCourtCore
    // flow without any of the partial-write windows that arise when the
    // route stitches storage calls together post-CAS.
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(matchSuggestions)
        .set({ status: 'playing' })
        .where(and(
          eq(matchSuggestions.id, suggestionId),
          eq(matchSuggestions.status, 'approved'),
        ))
        .returning();

      if (!updated) {
        // No row updated → the suggestion is either gone or no longer
        // 'approved'. Re-read inside the same tx for a consistent answer.
        const [current] = await tx
          .select()
          .from(matchSuggestions)
          .where(eq(matchSuggestions.id, suggestionId))
          .limit(1);

        if (!current) {
          return { result: 'not-found' as const };
        }
        if (current.status === 'playing') {
          return { result: 'already-started' as const, suggestion: current };
        }
        return { result: 'not-startable' as const, suggestion: current };
      }

      // Race winner: read the lineup and apply every side effect using
      // the same `tx` so a failure anywhere below rolls back the CAS.
      const lineup = await tx
        .select({
          playerId: matchSuggestionPlayers.playerId,
          team: matchSuggestionPlayers.team,
        })
        .from(matchSuggestionPlayers)
        .where(eq(matchSuggestionPlayers.suggestionId, suggestionId));

      // Court → occupied, fresh 15-minute timer, started_at = now.
      // Mirrors assignCourtCore exactly so the admin Court Management
      // screen and any other downstream consumer of `courts` see the
      // same canonical state regardless of who started the game.
      await tx
        .update(courts)
        .set({
          status: 'occupied',
          timeRemaining: 15,
          winningTeam: null,
          startedAt: new Date(),
        })
        .where(eq(courts.id, updated.courtId));

      // court_players: clear and rewrite from the suggestion lineup.
      // Delete-then-insert is the same shape `setCourtPlayersWithTeams`
      // uses for admin assigns; doing it inside the tx ensures we never
      // observe a half-rewritten roster.
      await tx
        .delete(courtPlayersTable)
        .where(eq(courtPlayersTable.courtId, updated.courtId));
      if (lineup.length > 0) {
        await tx.insert(courtPlayersTable).values(
          lineup.map(p => ({
            courtId: updated.courtId,
            playerId: p.playerId,
            team: p.team,
          })),
        );
      }

      // Per-player status → 'playing'. Single bulk UPDATE keyed by the
      // 4 player ids; cheaper than a loop and still atomic with the
      // outer tx.
      const playerIds = lineup.map(p => p.playerId);
      if (playerIds.length > 0) {
        await tx
          .update(players)
          .set({ status: 'playing' })
          .where(inArray(players.id, playerIds));

        // Remove these 4 from the session queue. assignCourtCore does
        // the equivalent via `setQueue(filtered)` after the helper
        // returns; doing it here in-tx keeps the start path symmetric
        // and prevents the matchmaker from re-suggesting players that
        // are already on a court.
        await tx
          .delete(queueEntries)
          .where(and(
            eq(queueEntries.sessionId, updated.sessionId),
            inArray(queueEntries.playerId, playerIds),
          ));
      }

      return { result: 'started' as const, suggestion: updated };
    });
  }

  // ─── Transactional game completion ───────────────────────────────────────
  async completeGameTransaction(args: {
    sessionId: string;
    courtId: string;
    team1Score: number;
    team2Score: number;
    winningTeam: number;
    matchSuggestionId?: string | null;
    isSandboxSession: boolean;
    playerIds: string[];
    computePerPlayer: (freshPlayers: Player[]) => Array<{
      playerId: string;
      team: number;
      skillBefore: number;
      skillAfter: number;
      playerUpdates: Partial<Player>;
    }>;
  }): Promise<{
    gameId: string;
    participants: Array<{ playerId: string; team: number; skillBefore: number; skillAfter: number }>;
    alreadySubmitted: boolean;
  }> {
    if (args.playerIds.length !== 4) {
      throw new Error(`completeGameTransaction expects exactly 4 players, got ${args.playerIds.length}`);
    }

    const gameId = randomUUID();

    return await db.transaction(async (tx) => {
      // ── Idempotency on matchSuggestionId (fast-path pre-check) ────────
      // game_results.matchSuggestionId is UNIQUE. If a game has already
      // been recorded for this suggestion (retried submission), short
      // circuit immediately — no reads of players, no writes.
      if (args.matchSuggestionId) {
        const [existing] = await tx
          .select()
          .from(gameResults)
          .where(eq(gameResults.matchSuggestionId, args.matchSuggestionId))
          .limit(1);
        if (existing) {
          const existingParticipants = await tx
            .select()
            .from(gameParticipants)
            .where(eq(gameParticipants.gameId, existing.id));
          return {
            gameId: existing.id,
            participants: existingParticipants.map(p => ({
              playerId: p.playerId,
              team: p.team,
              skillBefore: p.skillScoreBefore,
              skillAfter: p.skillScoreAfter,
            })),
            alreadySubmitted: true,
          };
        }
      }

      // Re-read all 4 players inside the transaction so skill calculations
      // use the freshest values, not whatever the route happened to read
      // before entering the tx. NOTE: Postgres' default isolation is
      // READ COMMITTED — this re-read narrows the stale-data window but
      // does NOT prevent two concurrent end-game requests from racing.
      // Court status gating in the route is the existing defense; row-level
      // SELECT FOR UPDATE locking and an admin-side idempotency token are
      // tracked as follow-up work for full concurrency safety.
      const freshRows = await tx
        .select()
        .from(players)
        .where(inArray(players.id, args.playerIds));
      if (freshRows.length !== 4) {
        throw new Error(`completeGameTransaction: expected 4 players in DB, found ${freshRows.length}`);
      }
      const freshPlayers: Player[] = freshRows.map(addSkidToPlayer);

      const computed = args.computePerPlayer(freshPlayers);
      if (computed.length !== 4) {
        throw new Error(`completeGameTransaction: computePerPlayer must return 4 entries, got ${computed.length}`);
      }

      // ── CLAIM: insert game_results FIRST so the matchSuggestionId unique
      //    index decides the winner BEFORE any player updates happen. If
      //    two end-game requests race past the pre-check above, only one
      //    will succeed here; the loser returns the canonical existing row
      //    without applying any player skill / stat deltas (preventing
      //    double-counting). matchSuggestionId is nullable — Postgres
      //    treats NULLs as distinct in unique indexes by default, so
      //    suggestion-less games never conflict here.
      const insertedRows = await tx
        .insert(gameResults)
        .values({
          id: gameId,
          courtId: args.courtId,
          sessionId: args.sessionId,
          team1Score: args.team1Score,
          team2Score: args.team2Score,
          winningTeam: args.winningTeam,
          matchSuggestionId: args.matchSuggestionId ?? null,
        })
        .onConflictDoNothing({ target: gameResults.matchSuggestionId })
        .returning({ id: gameResults.id });

      if (insertedRows.length === 0) {
        // Lost the race. By definition matchSuggestionId is non-null here
        // (NULLs cannot conflict). Return the canonical existing row with
        // NO player updates and NO participants insert.
        if (!args.matchSuggestionId) {
          throw new Error('completeGameTransaction: insert conflict without matchSuggestionId');
        }
        const [existing] = await tx
          .select()
          .from(gameResults)
          .where(eq(gameResults.matchSuggestionId, args.matchSuggestionId))
          .limit(1);
        if (!existing) {
          throw new Error('completeGameTransaction: conflict but no existing row found');
        }
        const existingParticipants = await tx
          .select()
          .from(gameParticipants)
          .where(eq(gameParticipants.gameId, existing.id));
        return {
          gameId: existing.id,
          participants: existingParticipants.map(p => ({
            playerId: p.playerId,
            team: p.team,
            skillBefore: p.skillScoreBefore,
            skillAfter: p.skillScoreAfter,
          })),
          alreadySubmitted: true,
        };
      }

      // ── Won the claim. Now safe to apply per-player updates. Sandbox
      //    sessions pass minimal updates (status only) — that's the
      //    caller's responsibility.
      for (const c of computed) {
        await tx.update(players).set(c.playerUpdates).where(eq(players.id, c.playerId));
      }

      // Insert game participants
      await tx.insert(gameParticipants).values(
        computed.map(c => ({
          gameId,
          playerId: c.playerId,
          team: c.team,
          skillScoreBefore: c.skillBefore,
          skillScoreAfter: c.skillAfter,
        }))
      );

      // If this game came from a match suggestion, mark it completed in the
      // same tx so the suggestion can never be re-submitted. The 4-row
      // lineup on match_suggestion_players is intentionally preserved across
      // the suggestion lifecycle for historical/marketplace reads;
      // getCurrentSuggestionForPlayer filters by parent.status IN
      // ('pending','approved'), so flipping to 'completed' here takes the
      // lineup out of the active set. The P8 score-entry screen resolves
      // this same row via a separate completed-fallback lookup in the
      // /current-suggestion route.
      if (args.matchSuggestionId) {
        await tx
          .update(matchSuggestions)
          .set({ status: 'completed' })
          .where(eq(matchSuggestions.id, args.matchSuggestionId));
      }

      return {
        gameId,
        participants: computed.map(c => ({
          playerId: c.playerId,
          team: c.team,
          skillBefore: c.skillBefore,
          skillAfter: c.skillAfter,
        })),
        alreadySubmitted: false,
      };
    });
  }
}

export const storage = new DatabaseStorage();
