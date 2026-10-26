import ts from "typescript";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { deny, type PluginServiceContracts } from "./contracts.js";

export const ADMISSION_POLICY_VERSION = "wish.admission/v1";
const runtimeExports: Readonly<Record<string, readonly string[]>> = {
  "wish/plugins/work-owner": ["PluginWorkOwner"],
  "wish/plugins/state": ["PluginStateError"],
  "wish/compaction/service": ["createCompactionResources"],
  "wish/tools/managed": ["ManagedToolOwner"],
  "wish/skills/local": ["FrozenSkills"],
};
const pureNode = new Set(["node:path", "node:url", "node:util", "node:crypto", "node:buffer", "node:events"]);
export interface ArchitectureInput {
  readonly entry: string;
  readonly tests: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: { readonly id: string; readonly state: { readonly mode: string }; readonly contracts?: PluginServiceContracts };
}
export interface ArchitectureReport {
  readonly policyVersion: typeof ADMISSION_POLICY_VERSION;
  readonly runtimeFiles: readonly string[];
  readonly imports: readonly { readonly file: string; readonly specifier: string; readonly typeOnly: boolean }[];
  readonly sourceCodeDigest: string;
}
function modulePath(from: string, name: string, files: Readonly<Record<string, string>>): string {
  const path = posix.normalize(posix.join(posix.dirname(from), name));
  if (path.startsWith("../") || path.startsWith("/")) deny("plugin_architecture_import_escape", `${from}:${name}`);
  const stem = path.replace(/\.[cm]?js$/, "");
  const candidates = [path, `${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${path}.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`];
  const found = candidates.find(candidate => Object.hasOwn(files, candidate));
  if (!found) deny("plugin_architecture_module_missing", `${from}:${name}`); return found;
}
function literal(node: ts.Node | undefined): string | undefined { return node && (ts.isStringLiteralLike(node)) ? node.text : undefined; }
function property(node: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : undefined;
}
function base(node: ts.Node): ts.Expression | undefined { return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined; }
function onlyTypes(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
  return node.importClause?.isTypeOnly === true || !!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    !node.importClause.name && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly);
}

/** Syntax-aware authoring boundary. The OS sandbox, never this scanner, confines unknown code. */
export function inspectArchitecture(input: ArchitectureInput): ArchitectureReport {
  const parsed = new Map<string, ts.SourceFile>();
  for (const [name, content] of Object.entries(input.files)) if (/\.[cm]?[jt]s$/.test(name)) parsed.set(name, ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS));
  const imports: { file: string; specifier: string; typeOnly: boolean }[] = [];
  const graph = new Map<string, string[]>();
  for (const [name, file] of parsed) {
    const children: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = literal(node.moduleSpecifier);
        if (specifier) {
          const typeOnly = onlyTypes(node);
          imports.push({ file: name, specifier, typeOnly });
          if (specifier.startsWith(".")) { const child = modulePath(name, specifier, input.files); if (!typeOnly) children.push(child); }
          else if (!specifier.startsWith("wish/") && !specifier.startsWith("node:") && !["@deepseek-ai/cordis", "@deepseek-ai/schemastery"].includes(specifier)) deny("plugin_architecture_import_forbidden", `${name}:${specifier}`);
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ["require", "eval"].includes(node.expression.text))) deny("plugin_architecture_dynamic_code", name);
      if (ts.isImportEqualsDeclaration(node)) deny("plugin_architecture_dynamic_code", name);
      ts.forEachChild(node, visit);
    };
    visit(file); graph.set(name, children);
  }
  const runtime = new Set<string>();
  const reach = (name: string) => { if (runtime.has(name)) return; runtime.add(name); for (const child of graph.get(name) ?? []) reach(child); };
  reach(input.entry);
  const requires = input.manifest.contracts?.requires ?? {}, provides = input.manifest.contracts?.provides ?? {};
  for (const [name, file] of parsed) {
    if (!runtime.has(name)) continue;
    const contexts = new Set<string>(["ctx"]);
    const collect = (node: ts.Node) => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(file) === "Context") contexts.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && contexts.has(node.initializer.text)) contexts.add(node.name.text);
      if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && propertyName(node.name) === "apply") {
        const fn = ts.isMethodDeclaration(node) ? node : ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) ? node.initializer : undefined;
        const parameter = fn?.parameters[0]; if (parameter && ts.isIdentifier(parameter.name)) contexts.add(parameter.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "apply" && node.parameters[0] && ts.isIdentifier(node.parameters[0].name)) contexts.add(node.parameters[0].name.text);
      ts.forEachChild(node, collect);
    }; collect(file);
    const isContext = (node: ts.Node | undefined): boolean => !!node && (ts.isIdentifier(node) && contexts.has(node.text) ||
      ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === "ctx");
    const hostReference = (expression: ts.Node): boolean => {
      let node: ts.Node | undefined = expression;
      while (node) { if (isContext(node) || ts.isIdentifier(node) && node.text === "process") return true; node = base(node); }
      return false;
    };
    const violation = (code: string, node: ts.Node) => { const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1; deny(code, `${name}:${line}`); };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = literal(node.moduleSpecifier);
        if (specifier && !specifier.startsWith(".") && !onlyTypes(node)) {
          if (specifier.startsWith("node:") && !pureNode.has(specifier)) violation("plugin_architecture_privileged_import", node);
          if (specifier.startsWith("wish/")) {
            const allowed = runtimeExports[specifier];
            if (!allowed || !ts.isImportDeclaration(node) || node.importClause?.name || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) ||
              node.importClause.namedBindings.elements.some(item => !item.isTypeOnly && !allowed.includes(item.propertyName?.text ?? item.name.text))) violation("plugin_architecture_core_boundary", node);
          }
          if (specifier === "@deepseek-ai/cordis" && (!ts.isImportDeclaration(node) || node.importClause?.name || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) ||
            node.importClause.namedBindings.elements.some(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) !== "Service"))) violation("plugin_architecture_core_boundary", node);
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ["Object", "Reflect"].includes(callee.expression.text) && node.arguments?.some(isContext)) violation("plugin_architecture_context_alias", node);
        if (ts.isIdentifier(callee) && ["Function", "setTimeout", "setInterval", "setImmediate", "fetch"].includes(callee.text)) violation("plugin_architecture_unowned_execution", node);
        if (isContext(base(callee))) {
          const method = property(callee), arg = node.arguments?.[0];
          if (method === "get") {
            if (!literal(arg) || !Object.hasOwn(requires, literal(arg)!)) violation("plugin_contract_access_undeclared", node);
            let parent: ts.Node = node.parent; while (ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) parent = parent.parent;
            if (!requires[literal(arg)!]!.methods.includes(property(parent) ?? "")) violation("plugin_contract_method_undeclared", node);
          }
          if (method === "provide" && (!literal(arg) || !Object.hasOwn(provides, literal(arg)!))) violation("plugin_contract_provide_undeclared", node);
          if (["on", "emit", "serial", "parallel", "waterfall"].includes(method ?? "") && (!literal(arg) || /^(?:internal|hmr)\//.test(literal(arg)!))) violation("plugin_architecture_host_control", node);
          if (method === "emit" && !literal(arg)?.startsWith(`${input.manifest.id}:`)) violation("plugin_architecture_host_control", node);
          if (method === "on" && node.arguments?.some(argument => ts.isObjectLiteralExpression(argument) && argument.properties.some(item => ts.isPropertyAssignment(item) && propertyName(item.name) === "global" && item.initializer.kind !== ts.SyntaxKind.FalseKeyword))) violation("plugin_architecture_host_control", node);
        }
        const service = base(callee), serviceName = service && property(service);
        if (service && isContext(base(service)) && serviceName && Object.hasOwn(requires, serviceName)) {
          const method = property(callee);
          if (!method || !requires[serviceName]!.methods.includes(method)) violation("plugin_contract_method_undeclared", node);
          if (["registerStrategy", "registerScoped", "registerProviderScoped", "selectScoped"].includes(method!) && !isContext(node.arguments?.[0])) violation("plugin_architecture_registration_owner", node);
        }
      }
      if (isContext(base(node))) {
        const key = property(node);
        if (key === "root") {
          const parent = node.parent, call = parent.parent;
          if (!(property(parent) === "get" && ts.isCallExpression(call) && literal(call.arguments[0]) === "pluginState" && input.manifest.state.mode === "versioned")) violation("plugin_architecture_host_control", node);
          let member: ts.Node = call.parent; while (ts.isNonNullExpression(member) || ts.isAsExpression(member)) member = member.parent;
          if (property(member) !== "open" || !ts.isCallExpression(member.parent) || !isContext(member.parent.arguments[0])) violation("plugin_architecture_host_control", node);
        } else if (!key || !["get", "provide", "effect", "on", "emit", "timeout", "interval", "throttle", "debounce"].includes(key) && !Object.hasOwn(requires, key)) violation("plugin_contract_access_undeclared", node);
        else if (Object.hasOwn(requires, key) && !requires[key]!.methods.includes(property(node.parent) ?? "")) violation("plugin_contract_method_undeclared", node);
        else if (["timeout", "interval", "throttle", "debounce"].includes(key) && !requires.timer?.methods.includes(key)) violation("plugin_contract_access_undeclared", node);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ["globalThis", "global"].includes(node.expression.text)) violation("plugin_architecture_host_control", node);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ["constructor", "prototype", "__proto__"].includes(property(node) ?? "")) violation("plugin_architecture_dynamic_code", node);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "process") {
        const key = property(node);
        if (!key || !["env", "version", "platform", "arch"].includes(key)) violation("plugin_architecture_host_control", node);
        if (key === "env" && !(ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))) violation("plugin_architecture_host_control", node);
      }
      if (ts.isIdentifier(node) && node.text === "process" && base(node.parent) !== node && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) violation("plugin_architecture_host_control", node);
      if (ts.isVariableDeclaration(node) && isContext(node.initializer) && !ts.isIdentifier(node.name) ||
        ts.isReturnStatement(node) && isContext(node.expression) || (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isContext(node.expression)) violation("plugin_architecture_context_alias", node);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && hostReference(node.left)) violation("plugin_architecture_host_mutation", node);
      if (ts.isDeleteExpression(node) && hostReference(node.expression) ||
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && hostReference(node.operand)) violation("plugin_architecture_host_mutation", node);
      ts.forEachChild(node, visit);
    }; visit(file);
  }
  return { policyVersion: ADMISSION_POLICY_VERSION, runtimeFiles: [...runtime].sort(), imports: imports.sort((a, b) => `${a.file}:${a.specifier}`.localeCompare(`${b.file}:${b.specifier}`)),
    sourceCodeDigest: createHash("sha256").update(JSON.stringify(Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
}
function propertyName(name: ts.PropertyName | undefined): string | undefined { return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined; }

/** Compiler output is rechecked in the Host before it is archived or imported. */
export function verifyCompiledImports(content: string, declared: readonly string[]): void {
  const file = ts.createSourceFile("plugin.mjs", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const name = literal(node.moduleSpecifier); if (name && !declared.includes(name)) deny("plugin_architecture_compiled_import", name);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) deny("plugin_architecture_dynamic_code");
    ts.forEachChild(node, visit);
  }; visit(file);
}
