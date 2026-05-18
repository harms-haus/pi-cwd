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

  const api = {
    registerCommand,
    on,
    appendEntry,
    sendMessage,
    registerMessageRenderer,
  } as unknown as ExtensionAPI;

  return {
    api,
    registerCommand,
    on,
    appendEntry,
    sendMessage,
    registerMessageRenderer,
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
  for (const [eventName, handler] of onMock.mock.calls) {
    handlers[eventName as string] = handler;
  }
  return handlers;
}

/**
 * Extract the name and options from the first `registerCommand` call.
 */
export function captureCommand(registerCommandMock: ReturnType<typeof vi.fn>) {
  const [name, options] = registerCommandMock.mock.calls[0];
  return { name, options };
}
