import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { walkFiles } from "./walkFiles.js";
import { resolveWithin } from "./resolveWithin.js";
import { toPosixPath } from "./strings.js";

/** Options for {@link exposeDocs}. */
export interface ExposeDocsOptions {
  /**
   * Directory holding the `*.md` documents, resolved relative to `packageDir`.
   * Defaults to `"docs"`.
   */
  docsDir?: string;
  /**
   * Descend into subdirectories, exposing nested documents under path-shaped
   * names (`docs:///reference/cli`). Defaults to `false`, which exposes only
   * the documents directly inside `docsDir`.
   */
  recursive?: boolean;
}

/**
 * Collect resource names: each document's path relative to `docsDir`, with
 * forward slashes and no `.md` extension.
 *
 * `walkFiles` is the scan engine on both paths, so the regular-file guarantee
 * from ADR-0001 applies to the flat scan too — a *directory* named `guide.md`
 * is never offered as a document, where the previous flat `readdirSync` would
 * have listed it and then failed the read with `EISDIR`.
 */
function collectDocNames(docsDir: string, recursive: boolean): string[] {
  const names = walkFiles(docsDir, ".md")
    .map((abs) => toPosixPath(path.relative(docsDir, abs)).slice(0, -".md".length))
    .filter((name) => recursive || !name.includes("/"));
  names.sort();
  return names;
}

/**
 * Register MCP resources serving a package's markdown documentation:
 * every `*.md` under `docsDir` via the `docs:///{+path}` template, plus
 * `README.md` as the static `docs:///readme`.
 *
 * Names are path-shaped and extension-less. Because RFC 6570 reserved
 * expansion also matches a name with no separator, every URI the previous
 * `docs:///{name}` template served keeps working unchanged.
 *
 * The read handler is guarded: reserved expansion matches `..` segments, so a
 * name is only served once {@link resolveWithin} confirms it stays inside
 * `docsDir`. An escaping name and a name with no file both raise
 * `McpError(InvalidParams)`, matching the SDK's own convention for a resource
 * it cannot resolve, rather than letting a raw `ENOENT` reach the client.
 *
 * The document set is read once, when `exposeDocs` is called — see the
 * README's note on the name list being a snapshot.
 */
export function exposeDocs(
  server: McpServer,
  packageDir: string,
  options: ExposeDocsOptions = {}
): void {
  const { docsDir: docsDirName = "docs", recursive = false } = options;
  const docsDir = path.resolve(packageDir, docsDirName);
  const readmePath = path.resolve(packageDir, "README.md");

  const docNames = collectDocNames(docsDir, recursive);

  server.resource(
    "docs",
    new ResourceTemplate("docs:///{+path}", {
      list: async () => ({
        resources: docNames.map((name) => ({
          uri: `docs:///${name}`,
          name,
          mimeType: "text/markdown",
        })),
      }),
      complete: {
        path: (_value: string) => docNames,
      },
    }),
    async (uri, { path: docPath }) => {
      const name = Array.isArray(docPath) ? docPath[0] : docPath;

      // `recursive` governs what is *served*, not merely what is listed, so a
      // nested name is refused outright when it is off. Deliberately a check on
      // the name's shape rather than membership of the collected set: the set is
      // a snapshot taken at registration, and a flat document added afterwards
      // is still served by name (see the README's note on the snapshot).
      if (!recursive && name.includes("/")) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${uri.href} is nested, but this server exposes ${docsDirName} non-recursively`
        );
      }

      const filePath = resolveWithin(docsDir, `${name}.md`);
      if (filePath === null) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${uri.href} resolves outside the documentation directory`
        );
      }

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri.href} not found`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  // Register static resource for README.md if it exists
  if (fs.existsSync(readmePath)) {
    server.resource("readme", "docs:///readme", async (uri) => {
      const content = fs.readFileSync(readmePath, "utf-8");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    });
  }
}
