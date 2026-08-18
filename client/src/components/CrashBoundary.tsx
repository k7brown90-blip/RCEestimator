/**
 * The crash boundary — a React render error becomes a report instead of a white screen. (P032)
 *
 * WHY. "Blank page" has now been reported twice, and both times the screen itself carried zero
 * information. The first was a server bug (the SPA fallback swallowing `/e/:token`); this catches
 * the other family — a component that throws during render, which React answers by unmounting the
 * whole tree and leaving an empty `<div id="root">`.
 *
 * When that happens there is no console for Kyle to open on a phone and nothing at all is written
 * down, so the report can only ever be "it went blank" — a symptom with the evidence already
 * destroyed. This records the error and the component stack to the debug bus, which ships it, and
 * then shows something honest and recoverable in place of the blank.
 *
 * It deliberately does NOT try to re-render the broken subtree automatically. A component that
 * threw once will usually throw again on the same state, and a boundary that retries in a loop
 * turns one report into hundreds.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { record, ship, getEntries } from "../lib/debugBus";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class CrashBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    record("error", `React render crash: ${error.message}`, {
      stack: error.stack,
      componentStack: info.componentStack,
    });
    // Ship immediately rather than waiting for the debounce — the user is looking at a broken
    // screen and their next action is very likely a reload, which would discard the buffer.
    void ship({
      message: `React render crash: ${error.message}`,
      entries: getEntries(),
      auto: true,
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="m-4 rounded-xl border border-red-300 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-900">This screen hit an error and stopped.</p>
        <p className="mt-1 text-xs text-red-800">
          It has been reported automatically, with the console attached. You can go back and keep
          working — nothing was saved incorrectly.
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-white p-2 font-mono text-[10px] text-red-900">
          {error.message}
        </pre>
        <button
          className="btn btn-primary mt-3"
          onClick={() => {
            this.setState({ error: null });
            window.history.back();
          }}
        >
          Go back
        </button>
      </div>
    );
  }
}
