import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock ExtensionAPI with all methods as vi.fn().
 * Returns both the shaped `api` object and individual fn references
 * for convenient assertion access.
 */
export function createMockAPI() {
  const registerCommand = vi.fn();
  const on = vi.fn();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const registerMessageRenderer = vi.fn();
  const events = {
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  };

  const api = {
    registerCommand,
    on,
    appendEntry,
    sendMessage,
    registerMessageRenderer,
    events,
  } as unknown as ExtensionAPI;

  return {
    api,
    registerCommand,
    on,
    appendEntry,
    sendMessage,
    registerMessageRenderer,
    events,
  };
}

/**
 * Create a mock ExtensionCommandContext.
 * Accepts optional overrides for any property.
 */
export function createMockContext(
  overrides: Record<string, unknown> = {},
): ExtensionCommandContext {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: {
        fg: vi.fn((_color: string, text: string) => text),
      },
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    cwd: process.cwd(),
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

// ============================================================================
// Capture Utilities
// ============================================================================

/**
 * Extract event handlers registered via `pi.on()` into a keyed object.
 * Keys are event names, values are the registered handler functions.
 */
export function captureHandlers(
  onMock: ReturnType<typeof vi.fn>,
): Record<string, (...args: unknown[]) => unknown> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const calls = onMock.mock.calls;
  for (const call of calls) {
    const [eventName, handler] = call as [string, (...args: unknown[]) => unknown];
    handlers[eventName] = handler;
  }
  return handlers;
}

/**
 * Extract the name and options from the first `registerCommand` call.
 */
export function captureCommand(registerCommandMock: ReturnType<typeof vi.fn>) {
  const [name, options] = registerCommandMock.mock.calls[0]!;
  return { name, options };
}
