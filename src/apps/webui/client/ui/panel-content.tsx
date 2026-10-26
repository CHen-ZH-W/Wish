import { Activity, useState, type ComponentType } from "react";
import type { UiPanel } from "../slots.js";
import { IsolatedView } from "./isolated-view.js";

interface RetainedPanel { readonly key: number; readonly View: ComponentType; readonly owners: readonly UiPanel[] }

/** Retention follows registered renderer identity, including removal and code replacement. */
export function PanelContent({ panels, active }: { panels: readonly UiPanel[]; active: UiPanel | undefined }) {
  const [visited, setVisited] = useState<{ readonly entries: readonly RetainedPanel[]; readonly nextKey: number }>({ entries: [], nextKey: 0 });
  const available = visited.entries.flatMap(entry => {
    const owners = panels.filter(panel => panel.preserveState && panel.View === entry.View);
    if (!entry.owners.some(owner => owners.includes(owner))) return [];
    return [owners.length === entry.owners.length && owners.every((owner, index) => owner === entry.owners[index]) ? entry : { ...entry, owners }];
  });
  let retained = available.length === visited.entries.length && available.every((entry, index) => entry === visited.entries[index]) ? visited.entries : available;
  let nextKey = visited.nextKey;
  if (active?.preserveState && !retained.some(entry => entry.View === active.View)) retained = [...retained, {
    key: nextKey++, View: active.View, owners: panels.filter(panel => panel.preserveState && panel.View === active.View),
  }];
  // Derive the visited set before committing, so first activation never mounts a temporary copy.
  if (retained !== visited.entries) setVisited({ entries: retained, nextKey });
  return <>
    {retained.map(entry => <Activity key={entry.key} mode={active?.preserveState && active.View === entry.View ? "visible" : "hidden"}>
      <IsolatedView View={entry.View} />
    </Activity>)}
    {active && !active.preserveState ? <IsolatedView key={`active/${active.id}`} View={active.View} /> : null}
  </>;
}
