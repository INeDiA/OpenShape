import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPanel } from "./HistoryPanel";
import { demoDocument } from "../model/doc";
import type { FeatureStatus } from "../model/types";

const noop = () => {};

describe("history panel", () => {
  it("offers to delete the features in error, and only then", () => {
    const { features } = demoDocument();
    const render = (status: Map<string, FeatureStatus>) =>
      renderToStaticMarkup(
        <HistoryPanel features={features} status={status} selectedId={null} onSelect={noop} onEdit={noop} onToggle={noop} onDelete={noop} onMove={noop} onDeleteErrors={noop} />,
      );
    expect(render(new Map())).not.toContain("with errors");
    const failing = new Map(features.slice(3).map((f) => [f.id, { id: f.id, ok: false, error: "boom" }]));
    const html = render(failing);
    expect(html).toContain("Delete 2 with errors");
    expect(html.match(/draggable="true"/g)).toHaveLength(features.length);
  });
});
