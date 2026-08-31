import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no scrollTo, and the router calls it on every navigation.
window.scrollTo = vi.fn();

afterEach(() => {
  cleanup();
});
