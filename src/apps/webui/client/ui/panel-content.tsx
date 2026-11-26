import { Activity, useState, type ComponentType } from "react";
import type { UiPanel } from "../slots.js";
import { IsolatedView } from "./isolated-view.js";
import { LoadingBoundary, pageLoading } from "./loading-boundary.js";
import type { UiLoadingState } from "../slots.js";

interface RetainedPanel { readonly key: number; readonly View: ComponentType; readonly owners: readonly UiPanel[]; readonly loading: { readonly identity: string; readonly pending: boolean } }

/** Retention follows registered renderer identity, including removal and code replacement. */
export function PanelContent({ panels, active, loading = [], surface = "View" }: { panels: readonly UiPanel[]; active: UiPanel | undefined; loading?: readonly UiLoadingState[]; surface?: "View" | "Sidebar" }) {
  const activeView = active?.[surface];
  const [visited, setVisited] = useState<{ readonly entries: readonly RetainedPanel[]; readonly nextKey: number }>({ entries: [], nextKey: 0 });
  const available = visited.entries.flatMap(entry => {
    const owners = panels.filter(panel => panel.preserveState && panel[surface] === entry.View);
    if (!entry.owners.some(owner => owners.includes(owner))) return [];
    return [owners.length === entry.owners.length && owners.every((owner, index) => owner === entry.owners[index]) ? entry : { ...entry, owners }];
  });
  let retained = available.length === visited.entries.length && available.every((entry, index) => entry === visited.entries[index]) ? visited.entries : available;
  let nextKey = visited.nextKey;
  if (active?.preserveState && activeView && !retained.some(entry => entry.View === activeView)) retained = [...retained, {
    key: nextKey++, View: activeView, owners: panels.filter(panel => panel.preserveState && panel[surface] === activeView), loading: pageLoading(loading, active.id),
  }];
  if (active?.preserveState) {
    const next = pageLoading(loading, active.id);
    const current = retained.find(entry => entry.View === activeView);
    if (current && (current.loading.identity !== next.identity || current.loading.pending !== next.pending)) retained = retained.map(entry => entry === current ? { ...entry, loading: next } : entry);
  }
  // Derive the visited set before committing, so first activation never mounts a temporary copy.
  if (retained !== visited.entries) setVisited({ entries: retained, nextKey });
  return <>
    {retained.map(entry => <Activity key={entry.key} mode={active?.preserveState && activeView === entry.View ? "visible" : "hidden"}>
      <LoadingBoundary {...entry.loading} active={active?.preserveState === true && activeView === entry.View}><IsolatedView View={entry.View} /></LoadingBoundary>
    </Activity>)}
    {active && activeView && !active.preserveState ? <LoadingBoundary key={`active/${active.id}`} {...pageLoading(loading, active.id)}><IsolatedView View={activeView} /></LoadingBoundary> : null}
  </>;
}
