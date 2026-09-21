/**
 * Shared render harness for the client's render-smoke tests (Phase A).
 *
 * Every page and card in this app assumes a react-query client and a router are
 * already above it (`QueryClientProvider`, `MemoryRouter` — see App.tsx), so a
 * bare `render(<Page/>)` throws before the component under test ever runs. This
 * wraps that assumption once instead of every test file repeating it.
 *
 * `retry: false` and a 0ms `gcTime`/`staleTime` are not about speed — a query
 * that retries keeps the test's fake timers (or real ones) spinning after the
 * assertions run, which is how a passing test leaves a dangling promise that
 * fails a LATER test with an unrelated error.
 */

import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

export function renderWithProviders(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
