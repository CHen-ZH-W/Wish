import { Component, type ComponentType, type ReactNode } from "react";
import { useText } from "../i18n.js";

function BrokenViewNotice() {
  const t = useText();
  return <p className="notice" role="alert">{t("此视图暂时无法显示。请更新对应界面模块或刷新页面，其他入口仍可使用。", "This view is temporarily unavailable. Update its UI module or refresh the page; other views remain available.")}</p>;
}

/** A broken optional renderer must not unmount the shell or its stable models. */
class ViewBoundary extends Component<{ identity: unknown; children: ReactNode }, { identity: unknown; failed: boolean }> {
  override state = { identity: this.props.identity, failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { identity: unknown }, state: { identity: unknown }) {
    return props.identity === state.identity ? null : { identity: props.identity, failed: false };
  }
  override render() {
    return this.state.failed ? <BrokenViewNotice /> : this.props.children;
  }
}
export function IsolatedView<P extends object>({ View, ...props }: { View: ComponentType<P> } & P) {
  return <ViewBoundary identity={View}><View {...props as P} /></ViewBoundary>;
}
