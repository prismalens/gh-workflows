import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { QueryError } from "./QueryState";

describe("QueryError on an auth-recovery state (#96)", () => {
  const originalLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "https://assayer.sfun.cloud/rounds", assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it.each([
    ["access_unconfigured", /no access team domain or audience configured/i],
    ["access_keys_unavailable", /could not fetch access's signing keys/i],
    ["access_denied", /missing, expired, or was rejected/i],
  ])("names the %s cause distinctly", (code, expectedText) => {
    render(<QueryError error={new ApiError("refused", 503, "unauthenticated", code)} />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("renders a visible Sign in again control", () => {
    render(<QueryError error={new ApiError("refused", 403, "unauthenticated", "access_denied")} />);
    expect(screen.getByRole("button", { name: /sign in again/i })).toBeVisible();
  });

  it("performs a real top-level navigation, never a fetch, on click", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<QueryError error={new ApiError("refused", 503, "unauthenticated", "access_unconfigured")} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in again/i }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://assayer.sfun.cloud/rounds");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not render the auth-recovery UI for a plain http error", () => {
    render(<QueryError error={new ApiError("boom", 500, "http")} />);
    expect(screen.queryByRole("button", { name: /sign in again/i })).not.toBeInTheDocument();
  });
});
