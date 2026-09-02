declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options: { readonly recursive: true },
  ): Promise<string | undefined>;

  export function readFile(path: string, encoding: "utf8"): Promise<string>;

  export function rename(oldPath: string, newPath: string): Promise<void>;

  export function unlink(path: string): Promise<void>;

  export function writeFile(
    path: string,
    data: string,
    options: {
      readonly encoding: "utf8";
      readonly mode: number;
      readonly flag: "wx";
    },
  ): Promise<void>;
}
