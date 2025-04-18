import type { Plugin, PluginContext } from "npm:rolldown@^1.0.0-beta.3-commit.fc7dd8c";
import {
  type ImportMap,
  resolveImportMap,
  resolveModuleSpecifier,
} from "jsr:@bureaudouble-forks/importmap@^0.2.1";
import { toFileUrl } from "jsr:/@std/path@^1.0.8/to-file-url";

enum DenoMediaType {
  JavaScript = "JavaScript",
  Mjs = "Mjs",
  Cjs = "Cjs",
  JSX = "JSX",
  TypeScript = "TypeScript",
  Mts = "Mts",
  Cts = "Cts",
  Dts = "Dts",
  Dmts = "Dmts",
  Dcts = "Dcts",
  TSX = "TSX",
  Json = "Json",
  Wasm = "Wasm",
  TsBuildInfo = "TsBuildInfo",
  SourceMap = "SourceMap",
  Unknown = "Unknown",
}

enum ModuleType {
  Js = "js",
  Jsx = "jsx",
  Ts = "ts",
  Tsx = "tsx",
  Json = "json",
  Binary = "binary",
  Text = "text",
  Empty = "empty",
}

interface ModuleInfoError {
  specifier: string;
  error: string;
}

type ModuleInfo = TypedModuleDetails | ModuleInfoError;

interface TypedModuleDetailsAsserted {
  specifier: string;
  local?: string;
  mediaType: DenoMediaType;
}

interface TypedModuleDetailsEsm {
  specifier: string;
  local?: string;
  mediaType: DenoMediaType;
}

interface TypedModuleDetailsNpm {
  specifier: string;
  npmPackage: string;
}

interface TypedModuleDetailsNode {
  specifier: string;
}

type TypedModuleDetails =
  | TypedModuleDetailsAsserted
  | TypedModuleDetailsEsm
  | TypedModuleDetailsNpm
  | TypedModuleDetailsNode;

interface DenoInfoJsonV1 {
  redirects: Record<string, string>;
  modules: ModuleInfo[];
}

interface DenoResolveResult {
  localPath?: string;
  redirected: string;
  moduleType?: ModuleType;
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type ExtractFunction<T> = T extends (...args: any[]) => any ? T
  : T extends { handler: (...args: unknown[]) => unknown } ? T["handler"]
  : never;

class DenoLoaderPlugin {
  private resolveDenoInfoCache: Map<string, DenoResolveResult>;
  private resolveModuleSpecifierCache: Map<string, string | null>;
  public importMap: ImportMap;
  public importMapBaseUrl: URL;
  public entryPoints: string[];
  public denoInfoCache?: DenoInfoJsonV1;

  constructor(
    importMap: ImportMap,
    importMapBaseUrl: string | URL,
    entryPoints?: string[],
    denoInfoCache?: DenoInfoJsonV1,
  ) {
    this.resolveModuleSpecifierCache = new Map<string, string>();
    this.resolveDenoInfoCache = new Map<string, DenoResolveResult>();
    this.importMapBaseUrl = new URL(importMapBaseUrl);
    this.entryPoints = entryPoints ?? [];
    this.importMap = resolveImportMap(importMap, this.importMapBaseUrl);
    this.denoInfoCache = denoInfoCache;
  }

  private async denoInfo(specifier: string): Promise<DenoInfoJsonV1> {
    console.time(`[deno-info] ${specifier}`);
    const uri = `data:application/json,${JSON.stringify(this.importMap)}`;
    const args = ["--no-config", "--quiet", "--import-map", uri];
    const command = new Deno.Command(Deno.execPath(), {
      args: ["info", ...args, "--json", specifier],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout);
    console.timeEnd(`[deno-info] ${specifier}`);
    return JSON.parse(output.toString());
  }

  private cacheDenoInfo(info: DenoInfoJsonV1) {
    for (const details of info.modules) {
      if (
        "specifier" in details &&
        !("npm_package" in details) &&
        "mediaType" in details
      ) {
        const result: DenoResolveResult = {
          localPath: details.local,
          redirected: details.specifier,
          moduleType: this.mapMediaType(details.mediaType),
        };
        this.resolveDenoInfoCache.set(
          details.specifier.replace("file://", ""),
          result,
        );
        for (const [key, value] of Object.entries(info.redirects)) {
          if (value === details.specifier) {
            this.resolveDenoInfoCache.set(key.replace("file://", ""), result);
          }
        }
      }
    }
  }

  private resolvePromises: Map<string, Promise<DenoResolveResult>> = new Map();
  private denoResolve(specifier: string): Promise<DenoResolveResult> {
    const cachedResult = this.resolveDenoInfoCache.get(specifier);
    if (cachedResult) return Promise.resolve(cachedResult);
    let promise = this.resolvePromises.get(specifier);
    if (!promise) {
      promise = (async () => {
        try {
          const info = await this.denoInfo(specifier);
          this.cacheDenoInfo(info);
          const cached = this.resolveDenoInfoCache.get(specifier);
          if (!cached) {
            throw new Error("Specifier not found in cache after processing");
          }
          return cached;
        } finally {
          this.resolvePromises.delete(specifier);
        }
      })();
      this.resolvePromises.set(specifier, promise);
    }
    return promise;
  }
  private mapMediaType(media_type: DenoMediaType): ModuleType {
    switch (media_type) {
      case DenoMediaType.JavaScript:
      case DenoMediaType.Mjs:
      case DenoMediaType.Cjs:
        return ModuleType.Js;
      case DenoMediaType.JSX:
        return ModuleType.Jsx;
      case DenoMediaType.TypeScript:
      case DenoMediaType.Mts:
      case DenoMediaType.Cts:
      case DenoMediaType.Dts:
      case DenoMediaType.Dmts:
      case DenoMediaType.Dcts:
        return ModuleType.Ts;
      case DenoMediaType.TSX:
        return ModuleType.Tsx;
      case DenoMediaType.Json:
        return ModuleType.Json;
      case DenoMediaType.Wasm:
        return ModuleType.Binary;
      case DenoMediaType.TsBuildInfo:
      case DenoMediaType.SourceMap:
        return ModuleType.Text;
      default:
        return ModuleType.Empty;
    }
  }

  private resolveFromImportMap(id: string, importer?: string): null | string {
    const key = JSON.stringify({ id, importer });
    const cacheValue = this.resolveModuleSpecifierCache.get(key);
    if (cacheValue !== undefined) return cacheValue;
    const importer_url = new URL(
      importer
        ? URL.canParse(importer) ? importer : toFileUrl(importer)
        : this.importMapBaseUrl,
    );
    let value = null;
    try {
      value = resolveModuleSpecifier(id, this.importMap, importer_url);
    } catch {}
    this.resolveModuleSpecifierCache.set(key, value);
    return value;
  }

  private extractPackageAndPath(
    specifier: string,
  ): [string | null, string | null] {
    const regex =
      /(?:[^:]+:\/?)?([@]?[^/\@]+\/[^/\@]+|[^/\@]+)(?:@[^/]*)?(?:\/(.+))?/;
    const match = specifier.match(regex);

    if (match) {
      const pkgName = match[1] || null;
      const path = match[2] || null;
      return [pkgName, path];
    }

    return [null, null];
  }

  get name() {
    return "@bureaudouble/rolldown-deno-loader-plugin";
  }

  async buildStart(
    _context: PluginContext,
    ..._args: Parameters<ExtractFunction<Plugin["buildStart"]>>
  ): Promise<Awaited<ReturnType<ExtractFunction<Plugin["buildStart"]>>>> {
    if (this.denoInfoCache) this.cacheDenoInfo(this.denoInfoCache);
    for (const entry of this.entryPoints) {
      await this.denoResolve(entry);
    }
  }

  async resolveId(
    context: PluginContext,
    ...[specifier, importer, options]: Parameters<
      ExtractFunction<Plugin["resolveId"]>
    >
  ): Promise<Awaited<ReturnType<ExtractFunction<Plugin["resolveId"]>>>> {
    let id = specifier;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      if (importer && !importer.includes("node_modules")) {
        const base_url = new URL(
          URL.canParse(importer) ? importer : toFileUrl(importer),
        );
        id = new URL(specifier, base_url).toString();
      }
    }

    let maybe_resolved = id;
    if (!id.startsWith(".") && !id.startsWith("/")) {
      maybe_resolved = this.resolveFromImportMap(id, importer) ?? id;
    }
    if (maybe_resolved.startsWith("node:")) {
      return { id: maybe_resolved, external: true };
    }
    if (maybe_resolved.startsWith("file:")) {
      const final_id = new URL(maybe_resolved).pathname;
      return { id: final_id, external: false };
    }
    if (maybe_resolved.startsWith("jsr:")) {
      const cached = await this.denoResolve(maybe_resolved);
      return { id: cached.redirected, external: false };
    }
    if (maybe_resolved.startsWith("npm:")) {
      const [package_name, package_path] = this.extractPackageAndPath(
        maybe_resolved,
      );
      const npm_package = (package_name && package_path
        ? `${package_name}/${package_path}`
        : package_name) ?? maybe_resolved;
      const res = await context.resolve(npm_package, undefined, {
        skipSelf: true,
        custom: { ...options.custom },
        ...({
          import_kind: options.kind,
          skip_self: true,
        } as unknown as Record<string, never>),
      });
      return res;
    }
    if (
      maybe_resolved.startsWith("http:") ||
      maybe_resolved.startsWith("https:")
    ) {
      return { id: maybe_resolved, external: false };
    }
  }

  async load(
    _context: PluginContext,
    ...[id]: Parameters<ExtractFunction<Plugin["load"]>>
  ): Promise<Awaited<ReturnType<ExtractFunction<Plugin["load"]>>>> {
    if (
      id.startsWith("jsr:") ||
      id.startsWith("http:") ||
      id.startsWith("https:")
    ) {
      const cached = await this.denoResolve(id);
      const localPath = cached.localPath;
      if (!localPath) throw Error("no local_path");
      const content = await Deno.readTextFile(localPath);
      const code = cached.moduleType === ModuleType.Json
        ? `export default ${content}`
        : content;
      const moduleType = cached.moduleType === ModuleType.Json
        ? ModuleType.Js
        : cached.moduleType;
      return { code, moduleType };
    }
  }
}

export const createDenoLoaderPlugin = (options: {
  importMap: ImportMap;
  importMapBaseUrl: string;
  entryPoints?: string[];
  denoInfoCache?: DenoInfoJsonV1;
}): Plugin => {
  const loader = new DenoLoaderPlugin(
    options.importMap,
    options.importMapBaseUrl,
    options.entryPoints,
    options.denoInfoCache,
  );

  return {
    name: loader.name,
    buildStart(...props) {
      return loader.buildStart(this, ...props);
    },
    resolveId(...props) {
      return loader.resolveId(this, ...props);
    },
    load(...props) {
      return loader.load(this, ...props);
    },
  };
};

export default createDenoLoaderPlugin;
