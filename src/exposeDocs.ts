import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";

export function exposeDocs(server: McpServer, packageDir: string): void {
  const docsDir = path.resolve(packageDir, "docs");
  const readmePath = path.resolve(packageDir, "README.md");

  // Collect available doc names from docs/ directory
  const docNames: string[] = [];
  if (fs.existsSync(docsDir)) {
    const entries = fs.readdirSync(docsDir);
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        docNames.push(entry.slice(0, -3));
      }
    }
  }

  // Register templated resource for docs/ files
  server.resource(
    "docs",
    new ResourceTemplate("docs:///{name}", {
      list: undefined,
      complete: {
        name: (_value: string) => docNames,
      },
    }),
    async (uri, { name }) => {
      const docName = Array.isArray(name) ? name[0] : name;
      const filePath = path.resolve(docsDir, `${docName}.md`);
      const content = fs.readFileSync(filePath, "utf-8");
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
