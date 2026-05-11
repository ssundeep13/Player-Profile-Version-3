import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/InstallAppBar', () => ({ InstallAppBar: () => null }));

import Play from '@/pages/marketplace/Play';

type FetchHandler = (url: string) => unknown;

function makeFetchMock(handlers: Record<string, FetchHandler>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) {
        const body = handler(url);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderPlay() {
  const memHook = memoryLocation({ path: '/marketplace/play', record: true });
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Mirror the production default fetcher so queries that pass only
        // a queryKey (no queryFn) actually issue requests against our
        // mocked global.fetch.
        queryFn: async ({ queryKey }) => {
          const url = queryKey.join('/') as string;
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        },
      },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={memHook.hook}>
        <Play />
      </Router>
    </QueryClientProvider>
  );
}

const checkedInBooking = {
  id: 'b1',
  status: 'attended',
  attendedAt: new Date().toISOString(),
  isGuestBooking: false,
  session: {
    id: 'bs-1',
    linkedSessionId: 'sess-1',
    title: 'Test session',
    date: new Date().toISOString(),
    venueName: 'Test Venue',
    venueMapUrl: null,
  },
};

describe('Play — WaitingScreen projection card', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders ProjectionCard when suggestion is null and projection is non-null (position > 1)', async () => {
    global.fetch = makeFetchMock({
      '/api/marketplace/bookings/mine': () => [checkedInBooking],
      '/api/marketplace/active-session': () => ({ activeSessionId: 'sess-1' }),
      '/api/marketplace/players/me/current-suggestion': () => ({
        suggestion: null,
        projection: {
          queuePosition: 3,
          projectedCourtId: 'c1',
          projectedCourtName: 'Court 1',
        },
      }),
      '/api/marketplace/players/me/today-stats': () => ({
        gamesPlayed: 0,
        wins: 0,
        skillScore: 100,
        tierName: 'Intermediate',
        queuePosition: 3,
        courtsInPlay: [],
        lastGame: null,
      }),
    }) as unknown as typeof fetch;

    renderPlay();

    await screen.findByTestId('card-projection');
    expect(screen.getByTestId('text-projection-heading')).toHaveTextContent(
      "You're #3 in the queue"
    );
    expect(screen.getByTestId('text-projection-court')).toHaveTextContent('Court 1');
    expect(screen.getByTestId('text-projection-helper')).toHaveTextContent(
      "You'll be notified when your game is ready."
    );
    // The bare "Finding your next game…" spinner must NOT render.
    expect(screen.queryByTestId('card-finding-game')).toBeNull();
  });

  it('renders position-1 copy when queuePosition === 1', async () => {
    global.fetch = makeFetchMock({
      '/api/marketplace/bookings/mine': () => [checkedInBooking],
      '/api/marketplace/active-session': () => ({ activeSessionId: 'sess-1' }),
      '/api/marketplace/players/me/current-suggestion': () => ({
        suggestion: null,
        projection: {
          queuePosition: 1,
          projectedCourtId: 'c1',
          projectedCourtName: 'Court 2',
        },
      }),
      '/api/marketplace/players/me/today-stats': () => ({
        gamesPlayed: 0,
        wins: 0,
        skillScore: 100,
        tierName: 'Intermediate',
        queuePosition: 1,
        courtsInPlay: [],
        lastGame: null,
      }),
    }) as unknown as typeof fetch;

    renderPlay();

    await screen.findByTestId('card-projection');
    expect(screen.getByTestId('text-projection-heading')).toHaveTextContent(
      "You're next on"
    );
    expect(screen.getByTestId('text-projection-heading')).toHaveTextContent(
      'waiting for the current game to end'
    );
    expect(screen.getByTestId('text-projection-court')).toHaveTextContent('Court 2');
  });

  it('falls back to FindingNextGameCard when both suggestion and projection are null', async () => {
    global.fetch = makeFetchMock({
      '/api/marketplace/bookings/mine': () => [checkedInBooking],
      '/api/marketplace/active-session': () => ({ activeSessionId: 'sess-1' }),
      '/api/marketplace/players/me/current-suggestion': () => ({
        suggestion: null,
        projection: null,
      }),
      '/api/marketplace/players/me/today-stats': () => ({
        gamesPlayed: 0,
        wins: 0,
        skillScore: 100,
        tierName: 'Intermediate',
        queuePosition: null,
        courtsInPlay: [],
        lastGame: null,
      }),
    }) as unknown as typeof fetch;

    renderPlay();

    await screen.findByTestId('card-finding-game');
    expect(screen.queryByTestId('card-projection')).toBeNull();
  });

  it('still renders the existing OnDeck card when a real queued suggestion exists (no projection swap)', async () => {
    global.fetch = makeFetchMock({
      '/api/marketplace/bookings/mine': () => [checkedInBooking],
      '/api/marketplace/active-session': () => ({ activeSessionId: 'sess-1' }),
      '/api/marketplace/players/me/current-suggestion': () => ({
        suggestion: {
          id: 's-1',
          status: 'queued',
          courtId: 'c1',
          courtName: 'Court 1',
          startedAt: null,
          pendingUntil: null,
          includesActivePlayers: false,
          selfTeam: 1,
          players: [
            { playerId: 'p1', playerName: 'Alpha', team: 1, photoUrl: null, tierName: 'Intermediate' },
            { playerId: 'p2', playerName: 'Bravo', team: 1, photoUrl: null, tierName: 'Intermediate' },
            { playerId: 'p3', playerName: 'Charlie', team: 2, photoUrl: null, tierName: 'Intermediate' },
            { playerId: 'p4', playerName: 'Delta', team: 2, photoUrl: null, tierName: 'Intermediate' },
          ],
        },
        // Projection should be ignored entirely when suggestion is present.
        projection: {
          queuePosition: 5,
          projectedCourtId: 'c2',
          projectedCourtName: 'Court 2',
        },
      }),
      '/api/marketplace/players/me/today-stats': () => ({
        gamesPlayed: 0,
        wins: 0,
        skillScore: 100,
        tierName: 'Intermediate',
        queuePosition: 1,
        courtsInPlay: [],
        lastGame: null,
      }),
    }) as unknown as typeof fetch;

    renderPlay();

    await waitFor(() => {
      expect(screen.getByTestId('card-on-deck')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('card-projection')).toBeNull();
    expect(screen.queryByTestId('card-finding-game')).toBeNull();
  });
});
