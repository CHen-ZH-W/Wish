import type { LedgerBlock } from "../projection/ledger.js";
import { useText } from "../i18n.js";
export function GenericToolDetails({ block }: { block: LedgerBlock }) {
  const t = useText();
  return <>{block.input ? <><h3>{t("输入", "Input")}</h3><pre>{block.input}</pre></> : null}<h3>{t("输出", "Output")}</h3><pre>{block.text || t("尚未收到结果", "No result yet")}</pre></>;
}
