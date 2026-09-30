import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfigPrError, type ConfigPrRequest } from "@/api/client";
import { FIXTURE_CONFIG_FILE, makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { renderRoute } from "@/test/renderRoute";

const SRE = "prismalens/sreforge";
const SHA = "0".repeat(40);

async function openEditor(api = makeFixtureApi(makeRounds({ count: 24 }))) {
  renderRoute({ path: `/repos/${SRE}?tab=config`, api });
  fireEvent.click(await screen.findByTestId("config-edit"));
  return screen.findByTestId("config-editor");
}

describe("the Config tab edits the file through a pull request (#78)", () => {
  it("a form change shows its diff and opens a PR that carries the whole file and the changed key", async () => {
    const openConfigPr = vi.fn(async (req: ConfigPrRequest) => ({
      url: `https://github.com/${req.repository}/pull/41`,
      number: 41,
      branch: "assayer/config-x",
    }));
    const editor = await openEditor({ ...makeFixtureApi(makeRounds({ count: 24 })), openConfigPr });

    const open = within(editor).getByRole("button", { name: "Open pull request" });
    expect(open).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("review.level"), { target: { value: "high" } });

    expect(within(editor).getByTestId("config-diff").textContent).toContain("+   level: high");
    fireEvent.click(open);
    await screen.findByTestId("config-pr-opened");
    expect(openConfigPr).toHaveBeenCalledWith({
      repository: SRE,
      content: FIXTURE_CONFIG_FILE.replace("level: medium", "level: high"),
      base_sha: SHA,
      summary: ["review.level: medium → high"],
    });
    expect(screen.getByRole("link", { name: /pull\/41/ })).toHaveAttribute("href", `https://github.com/${SRE}/pull/41`);
  });

  it("a list field commits on blur, one entry per line", async () => {
    const editor = await openEditor();
    const box = within(editor).getByLabelText("review.skip_authors");
    fireEvent.change(box, { target: { value: "dependabot[bot]\n renovate[bot] \n" } });
    fireEvent.blur(box);
    expect(within(editor).getByTestId("config-diff").textContent).toContain("+     - renovate[bot]");
  });

  it("a file the lane would reject names the key and keeps the button disabled", async () => {
    const editor = await openEditor();
    fireEvent.click(within(editor).getByRole("tab", { name: "YAML" }));
    fireEvent.change(within(editor).getByLabelText("config file"), {
      target: { value: "version: 1\nreview:\n  level: low\n" },
    });
    expect(within(editor).getByTestId("config-errors").textContent).toContain("review/level");
    expect(within(editor).getByRole("button", { name: "Open pull request" })).toBeDisabled();
  });

  it("without Contents: write it offers the YAML and GitHub's editor instead of a PR", async () => {
    const base = makeFixtureApi(makeRounds({ count: 24 }));
    const editor = await openEditor({
      ...base,
      fetchConfigFile: async (repository) => ({ ...(await base.fetchConfigFile(repository)), can_open_pr: false }),
    });
    expect(within(editor).queryByRole("button", { name: "Open pull request" })).toBeNull();
    expect(within(editor).getByTestId("config-manual")).toBeInTheDocument();
    expect(within(editor).getByRole("link", { name: /on GitHub/ })).toHaveAttribute(
      "href",
      `https://github.com/${SRE}/edit/main/.github/claude-review.yml`,
    );
  });

  it("a file changed on GitHub meanwhile is refused with a way to reload", async () => {
    const editor = await openEditor({
      ...makeFixtureApi(makeRounds({ count: 24 })),
      openConfigPr: async () => {
        throw new ConfigPrError("config-changed");
      },
    });
    fireEvent.change(within(editor).getByLabelText("findings.suppress_below"), { target: { value: "Major" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Open pull request" }));
    const refused = await screen.findByTestId("config-pr-refused");
    expect(refused.textContent).toContain("changed on GitHub");
    expect(within(refused).getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("a repository without the App says so instead of an editor", async () => {
    renderRoute({
      path: `/repos/${SRE}?tab=config`,
      api: {
        ...makeFixtureApi(makeRounds({ count: 24 })),
        fetchConfigFile: async () => {
          throw new Error("GET /api/config-file returned 404: not-installed");
        },
      },
    });
    fireEvent.click(await screen.findByTestId("config-edit"));
    await waitFor(() => expect(screen.getByTestId("config-file-error").textContent).toContain("not installed"));
  });
});
