import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import ignore from "ignore";

import type {
  AnalysisResult,
  EdgeType,
  GraphEdge,
  GraphNode,
  RepoNarrative,
  RepoSummary,
  SourceType
} from "../../../shared/src/index.js";
import { generateInsights } from "./insights.js";

const execFileAsync = promisify(execFile);
const traverse = (
  (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
) as unknown as (typeof import("@babel/traverse"))["default"];
const JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "out",
  ".idea",
  ".vscode",
  "backend/data",
  "backend/dist",
  "frontend/dist"
];

interface AnalyzeOptions {
  source: string;
  ref?: string;
}

interface MaterializedSource {
  source: string;
  sourceType: SourceType;
  rootPath: string;
  repoName: string;
  ref?: string;
  headSha?: string;
  github?: {
    owner: string;
    repo: string;
    url: string;
  };
}

interface FileStats {
  size: number;
  extension: string;
  lastModified: string;
  commits: number;
  recentCommitIds: string[];
  authors: Map<string, number>;
  lastTouchedAt?: string;
}

interface Contributor {
  name: string;
  email?: string;
  commits: number;
}

interface OwnershipSummary {
  name: string;
  email?: string;
  commits: number;
  share: number;
}

interface GitHubRepoResponse {
  full_name: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  html_url: string;
}

interface GitHubIssueResponse {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  created_at: string;
  comments: number;
  comments_url: string;
  user?: {
    login: string;
  };
  assignees?: Array<{
    login: string;
  }>;
  pull_request?: {
    html_url: string;
  };
}

interface GitHubCommentResponse {
  id: number;
  html_url: string;
  body: string | null;
  created_at: string;
  user?: {
    login: string;
  };
}

interface SymbolRange {
  id: string;
  start: number;
  end: number;
}

interface MutableContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeMap: Map<string, GraphNode>;
  edgeKeys: Set<string>;
  fileIdsByPath: Map<string, string>;
  dependencyIds: Map<string, string>;
  fileStats: Map<string, FileStats>;
  entryPointIds: Set<string>;
  packageScripts: Array<{ packageName: string; scriptName: string; command: string }>;
  contributors: Map<string, Contributor>;
  fileOwnership: Map<string, OwnershipSummary>;
  fileActivity: Map<string, { commits: number; lastTouchedAt?: string }>;
  githubSummary?: RepoSummary["github"];
}

export async function analyzeRepository(options: AnalyzeOptions): Promise<AnalysisResult> {
  const materialized = await materializeSource(options);
  const context = createContext();
  const generatedAt = new Date().toISOString();
  const repoId = `repo:${materialized.repoName}`;

  addNode(context, {
    id: repoId,
    type: "Repo",
    label: materialized.repoName,
    path: ".",
    data: {
      source: materialized.source,
      sourceType: materialized.sourceType,
      resolvedPath: materialized.rootPath
    }
  });

  await buildFileTree(materialized.rootPath, repoId, context);
  await parseManifestsAndSource(materialized.rootPath, context);
  await collectGitData(materialized.rootPath, repoId, materialized, context);
  await collectGitHubData(repoId, materialized, context);

  const fileTestMatches = buildTestMatches(context.fileIdsByPath);
  applyMetrics(context);

  const insights = generateInsights({
    nodes: context.nodes,
    edges: context.edges,
    entryPointIds: context.entryPointIds,
    fileTestMatches,
    fileOwnership: context.fileOwnership,
    fileActivity: context.fileActivity
  });

  const summary = buildSummary(materialized, generatedAt, context, insights);
  const id = `${summary.repoName}:${generatedAt}`;

  return {
    id,
    summary,
    graph: {
      nodes: context.nodes,
      edges: context.edges
    },
    insights
  };
}

async function materializeSource(options: AnalyzeOptions): Promise<MaterializedSource> {
  const normalizedSource = options.source.trim();
  const normalizedRef = options.ref?.trim();

  if (normalizedSource.length === 0 || normalizedSource.length > 2048) {
    throw new Error("Source must be a non-empty path or GitHub URL.");
  }

  if (normalizedRef && !isSafeGitRef(normalizedRef)) {
    throw new Error("Ref contains invalid characters.");
  }

  const localPath = path.resolve(expandHomeDirectory(normalizedSource));

  if (await pathExists(localPath)) {
    const headSha = await getGitValue(localPath, ["rev-parse", "HEAD"]);
    const ref = normalizedRef ?? (await getGitValue(localPath, ["rev-parse", "--abbrev-ref", "HEAD"]));

    return {
      source: normalizedSource,
      sourceType: "local",
      rootPath: localPath,
      repoName: path.basename(localPath),
      ref: ref && ref !== "HEAD" ? ref : undefined,
      headSha: headSha ?? undefined
    };
  }

  const github = parseGitHubUrl(normalizedSource);

  if (!github) {
    throw new Error("Source must be an existing local path or a GitHub repository URL.");
  }

  const requestedRef = normalizedRef ?? github.ref;
  if (requestedRef && !isSafeGitRef(requestedRef)) {
    throw new Error("Ref contains invalid characters.");
  }

  const cloned = await cloneGitHubRepository(github.url, github.owner, github.repo, requestedRef);

  return {
    source: normalizedSource,
    sourceType: "github",
    rootPath: cloned.rootPath,
    repoName: `${github.owner}/${github.repo}`,
    ref: cloned.ref,
    headSha: cloned.headSha,
    github: {
      owner: github.owner,
      repo: github.repo,
      url: github.url
    }
  };
}

function createContext(): MutableContext {
  return {
    nodes: [],
    edges: [],
    nodeMap: new Map<string, GraphNode>(),
    edgeKeys: new Set<string>(),
    fileIdsByPath: new Map<string, string>(),
    dependencyIds: new Map<string, string>(),
    fileStats: new Map<string, FileStats>(),
    entryPointIds: new Set<string>(),
    packageScripts: [],
    contributors: new Map<string, Contributor>(),
    fileOwnership: new Map<string, OwnershipSummary>(),
    fileActivity: new Map<string, { commits: number; lastTouchedAt?: string }>()
  };
}

async function buildFileTree(rootPath: string, repoId: string, context: MutableContext): Promise<void> {
  const matcher = await createIgnoreMatcher(rootPath);

  const walk = async (directoryPath: string, parentId: string): Promise<void> => {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toRelative(rootPath, absolutePath);

      if (!relativePath || shouldIgnore(matcher, relativePath, entry.isDirectory())) {
        continue;
      }

      if (entry.isDirectory()) {
        const directoryId = `directory:${relativePath}`;
        addNode(context, {
          id: directoryId,
          type: "Directory",
          label: entry.name,
          path: relativePath,
          parentId,
          data: {
            depth: relativePath.split("/").length
          }
        });
        addEdge(context, parentId, directoryId, "contains");
        addEdge(context, parentId, directoryId, "parent_of");
        await walk(absolutePath, directoryId);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stats = await fs.stat(absolutePath);
      const extension = path.extname(entry.name).toLowerCase();
      const fileId = `file:${relativePath}`;

      addNode(context, {
        id: fileId,
        type: "File",
        label: entry.name,
        path: relativePath,
        parentId,
        data: {
          extension,
          language: inferLanguage(relativePath),
          relativeDir: path.posix.dirname(relativePath)
        }
      });
      addEdge(context, parentId, fileId, "contains");
      context.fileIdsByPath.set(relativePath, fileId);
      context.fileStats.set(fileId, {
        size: stats.size,
        extension,
        lastModified: stats.mtime.toISOString(),
        commits: 0,
        recentCommitIds: [],
        authors: new Map<string, number>()
      });
    }
  };

  await walk(rootPath, repoId);
}

async function parseManifestsAndSource(rootPath: string, context: MutableContext): Promise<void> {
  for (const [relativePath, fileId] of context.fileIdsByPath) {
    const absolutePath = path.join(rootPath, relativePath);

    if (path.posix.basename(relativePath) === "package.json") {
      await parsePackageManifest(rootPath, absolutePath, relativePath, fileId, context);
    }

    if (JS_TS_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      await parseCodeFile(rootPath, absolutePath, relativePath, fileId, context);
    }
  }
}

async function parsePackageManifest(
  rootPath: string,
  absolutePath: string,
  relativePath: string,
  fileId: string,
  context: MutableContext
): Promise<void> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const manifest = JSON.parse(raw) as {
      name?: string;
      version?: string;
      main?: string;
      bin?: string | Record<string, string>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const packageId = `package:${relativePath}`;
    const packageName = manifest.name ?? path.basename(path.dirname(absolutePath));
    addNode(context, {
      id: packageId,
      type: "Package",
      label: packageName,
      path: relativePath,
      parentId: fileId,
      data: {
        name: manifest.name ?? packageName,
        version: manifest.version ?? "0.0.0",
        scripts: manifest.scripts ?? {}
      }
    });
    addEdge(context, fileId, packageId, "defines");

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      const dependencyId = ensureDependencyNode(context, name, version);
      addEdge(context, packageId, dependencyId, "depends_on", { version });
    }

    for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
      const dependencyId = ensureDependencyNode(context, name, version);
      addEdge(context, packageId, dependencyId, "dev_depends_on", { version });
    }

    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
      context.packageScripts.push({
        packageName,
        scriptName,
        command
      });
    }

    if (manifest.main) {
      const targetId = resolveProjectFileTarget(path.dirname(absolutePath), manifest.main, context.fileIdsByPath, rootPath);

      if (targetId) {
        context.entryPointIds.add(targetId);
      }
    }

    if (typeof manifest.bin === "string") {
      const targetId = resolveProjectFileTarget(path.dirname(absolutePath), manifest.bin, context.fileIdsByPath, rootPath);

      if (targetId) {
        context.entryPointIds.add(targetId);
      }
    }

    if (manifest.bin && typeof manifest.bin === "object") {
      for (const binPath of Object.values(manifest.bin)) {
        const targetId = resolveProjectFileTarget(path.dirname(absolutePath), binPath, context.fileIdsByPath, rootPath);

        if (targetId) {
          context.entryPointIds.add(targetId);
        }
      }
    }
  } catch (error) {
    annotateNode(context, fileId, {
      manifestError: error instanceof Error ? error.message : String(error)
    });
  }
}

async function parseCodeFile(
  rootPath: string,
  absolutePath: string,
  relativePath: string,
  fileId: string,
  context: MutableContext
): Promise<void> {
  let content = "";

  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    annotateNode(context, fileId, {
      parseError: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  try {
    const ast = parse(content, {
      sourceType: "unambiguous",
      ranges: false,
      tokens: false,
      plugins: [
        "jsx",
        ["typescript", { dts: relativePath.endsWith(".d.ts") }],
        "decorators-legacy",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "objectRestSpread",
        "dynamicImport",
        "importMeta",
        "topLevelAwait"
      ] as never
    });

    const declaredSymbols = new Map<string, string>();
    const importedSymbols = new Map<string, string>();
    const ownerRanges: SymbolRange[] = [];
    let importCounter = 0;

    const registerOwner = (nodeId: string, start?: number | null, end?: number | null): void => {
      if (typeof start === "number" && typeof end === "number") {
        ownerRanges.push({ id: nodeId, start, end });
      }
    };

    traverse(ast, {
      ImportDeclaration(nodePath) {
        const sourceValue = typeof nodePath.node.source.value === "string" ? nodePath.node.source.value : "";
        const importId = `import:${relativePath}:${importCounter}`;
        importCounter += 1;

        addNode(context, {
          id: importId,
          type: "Import",
          label: sourceValue,
          path: relativePath,
          parentId: fileId,
          data: {
            source: sourceValue,
            specifiers: nodePath.node.specifiers.map((specifier) => {
              if (specifier.type === "ImportSpecifier") {
                return specifier.imported.type === "Identifier" ? specifier.imported.name : "default";
              }

              return "default";
            })
          }
        });
        addEdge(context, fileId, importId, "contains");

        const targetId = resolveImportTarget(rootPath, absolutePath, sourceValue, context);

        if (targetId) {
          addEdge(context, fileId, targetId, "imports", { source: sourceValue });
        }

        for (const specifier of nodePath.node.specifiers) {
          importedSymbols.set(specifier.local.name, targetId ?? importId);
        }
      },
      FunctionDeclaration(nodePath) {
        if (!isTopLevel(nodePath.parent?.type)) {
          return;
        }

        const name = nodePath.node.id?.name ?? `anonymous_${nodePath.node.start ?? importCounter}`;
        const functionId = `function:${relativePath}:${name}:${nodePath.node.loc?.start.line ?? 0}`;

        addNode(context, {
          id: functionId,
          type: "Function",
          label: name,
          path: relativePath,
          parentId: fileId,
          data: {
            async: Boolean(nodePath.node.async),
            generator: Boolean(nodePath.node.generator),
            line: nodePath.node.loc?.start.line ?? null
          }
        });
        addEdge(context, fileId, functionId, "defines");
        declaredSymbols.set(name, functionId);
        registerOwner(functionId, nodePath.node.start, nodePath.node.end);
      },
      VariableDeclarator(nodePath) {
        if (nodePath.node.id.type !== "Identifier") {
          return;
        }

        const variableName = nodePath.node.id.name;

        if (nodePath.node.init?.type === "CallExpression" && getSimpleCalleeName(nodePath.node.init.callee) === "require") {
          const literal = nodePath.node.init.arguments[0];
          const sourceValue = literal?.type === "StringLiteral" ? literal.value : undefined;

          if (sourceValue) {
            const importId = `import:${relativePath}:${importCounter}`;
            importCounter += 1;
            addNode(context, {
              id: importId,
              type: "Import",
              label: sourceValue,
              path: relativePath,
              parentId: fileId,
              data: {
                source: sourceValue,
                specifiers: [variableName]
              }
            });
            addEdge(context, fileId, importId, "contains");

            const targetId = resolveImportTarget(rootPath, absolutePath, sourceValue, context);

            if (targetId) {
              addEdge(context, fileId, targetId, "imports", { source: sourceValue });
            }

            importedSymbols.set(variableName, targetId ?? importId);
          }
        }

        const isProgramLevel =
          nodePath.parentPath?.parent?.type === "Program" || nodePath.parentPath?.parent?.type === "ExportNamedDeclaration";

        if (!isProgramLevel) {
          return;
        }

        const initializer = nodePath.node.init;

        if (initializer?.type === "ArrowFunctionExpression" || initializer?.type === "FunctionExpression") {
          const functionId = `function:${relativePath}:${variableName}:${initializer.loc?.start.line ?? 0}`;

          addNode(context, {
            id: functionId,
            type: "Function",
            label: variableName,
            path: relativePath,
            parentId: fileId,
            data: {
              async: Boolean(initializer.async),
              line: initializer.loc?.start.line ?? null
            }
          });
          addEdge(context, fileId, functionId, "defines");
          declaredSymbols.set(variableName, functionId);
          registerOwner(functionId, initializer.start, initializer.end);
          return;
        }

        const variableId = `variable:${relativePath}:${variableName}:${nodePath.node.loc?.start.line ?? 0}`;
        addNode(context, {
          id: variableId,
          type: "Variable",
          label: variableName,
          path: relativePath,
          parentId: fileId,
          data: {
            line: nodePath.node.loc?.start.line ?? null
          }
        });
        addEdge(context, fileId, variableId, "defines");
        declaredSymbols.set(variableName, variableId);
        registerOwner(variableId, nodePath.node.start, nodePath.node.end);
      },
      ClassDeclaration(nodePath) {
        if (!isTopLevel(nodePath.parent?.type)) {
          return;
        }

        const name = nodePath.node.id?.name ?? `AnonymousClass${nodePath.node.start ?? 0}`;
        const classId = `class:${relativePath}:${name}:${nodePath.node.loc?.start.line ?? 0}`;

        addNode(context, {
          id: classId,
          type: "Class",
          label: name,
          path: relativePath,
          parentId: fileId,
          data: {
            line: nodePath.node.loc?.start.line ?? null
          }
        });
        addEdge(context, fileId, classId, "defines");
        declaredSymbols.set(name, classId);
        registerOwner(classId, nodePath.node.start, nodePath.node.end);

        if (nodePath.node.superClass?.type === "Identifier") {
          const targetId = declaredSymbols.get(nodePath.node.superClass.name) ?? importedSymbols.get(nodePath.node.superClass.name);

          if (targetId) {
            addEdge(context, classId, targetId, "inherits");
          }
        }

        for (const member of nodePath.node.body.body) {
          if (!("key" in member) || !("loc" in member)) {
            continue;
          }

          if (member.type !== "ClassMethod" && member.type !== "ClassPrivateMethod" && member.type !== "TSDeclareMethod") {
            continue;
          }

          const keyNode = member.key;
          const methodName =
            keyNode.type === "Identifier"
              ? keyNode.name
              : keyNode.type === "StringLiteral"
                ? keyNode.value
                : keyNode.type === "PrivateName" && keyNode.id.type === "Identifier"
                  ? `#${keyNode.id.name}`
                  : `method_${member.start ?? 0}`;
          const methodId = `method:${relativePath}:${name}.${methodName}:${member.loc?.start.line ?? 0}`;

          addNode(context, {
            id: methodId,
            type: "Method",
            label: methodName,
            path: relativePath,
            parentId: classId,
            data: {
              className: name,
              line: member.loc?.start.line ?? null
            }
          });
          addEdge(context, classId, methodId, "defines");
          registerOwner(methodId, member.start, member.end);
        }
      },
      TSInterfaceDeclaration(nodePath) {
        const typeId = `type:${relativePath}:${nodePath.node.id.name}:${nodePath.node.loc?.start.line ?? 0}`;
        addNode(context, {
          id: typeId,
          type: "Type",
          label: nodePath.node.id.name,
          path: relativePath,
          parentId: fileId,
          data: {
            line: nodePath.node.loc?.start.line ?? null
          }
        });
        addEdge(context, fileId, typeId, "defines");
      },
      TSTypeAliasDeclaration(nodePath) {
        const typeId = `type:${relativePath}:${nodePath.node.id.name}:${nodePath.node.loc?.start.line ?? 0}`;
        addNode(context, {
          id: typeId,
          type: "Type",
          label: nodePath.node.id.name,
          path: relativePath,
          parentId: fileId,
          data: {
            line: nodePath.node.loc?.start.line ?? null
          }
        });
        addEdge(context, fileId, typeId, "defines");
      },
      ExportNamedDeclaration(nodePath) {
        if (!nodePath.node.source?.value || typeof nodePath.node.source.value !== "string") {
          return;
        }

        const targetId = resolveImportTarget(rootPath, absolutePath, nodePath.node.source.value, context);

        if (targetId) {
          addEdge(context, fileId, targetId, "references", {
            source: nodePath.node.source.value
          });
        }
      }
    });

    traverse(ast, {
      CallExpression(nodePath) {
        const calleeName = getSimpleCalleeName(nodePath.node.callee);

        if (!calleeName) {
          return;
        }

        const targetId = declaredSymbols.get(calleeName) ?? importedSymbols.get(calleeName);

        if (!targetId) {
          return;
        }

        const sourceId = findOwner(ownerRanges, nodePath.node.start) ?? fileId;

        if (sourceId !== targetId) {
          addEdge(context, sourceId, targetId, "calls");
        }
      }
    });

    const baseName = path.posix.basename(relativePath).toLowerCase();
    if (/^(index|main|app|cli)\.(tsx?|jsx?|mjs|cjs)$/.test(baseName)) {
      context.entryPointIds.add(fileId);
    }
  } catch (error) {
    annotateNode(context, fileId, {
      parseError: error instanceof Error ? error.message : String(error)
    });
  }
}

async function collectGitData(
  rootPath: string,
  repoId: string,
  materialized: MaterializedSource,
  context: MutableContext
): Promise<void> {
  const isGitRepo = (await getGitValue(rootPath, ["rev-parse", "--is-inside-work-tree"])) === "true";

  if (!isGitRepo) {
    return;
  }

  const ref = materialized.ref ?? (await getGitValue(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? undefined;
  materialized.ref = ref && ref !== "HEAD" ? ref : materialized.ref;
  materialized.headSha = materialized.headSha ?? (await getGitValue(rootPath, ["rev-parse", "HEAD"])) ?? undefined;

  const rawLog = await getGitValue(
    rootPath,
    ["log", "--date=iso-strict", "--pretty=format:commit%x1f%H%x1f%an%x1f%ae%x1f%ad%x1f%s", "--name-only", "-n", "120"],
    false
  );

  if (!rawLog) {
    return;
  }

  const lines = rawLog.split(/\r?\n/);
  let currentCommit:
    | {
        sha: string;
        authorName: string;
        authorEmail: string;
        authoredAt: string;
        subject: string;
      }
    | null = null;
  let changedEdgeCount = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith("commit\u001f")) {
      const [, sha, authorName, authorEmail, authoredAt, subject] = line.split("\u001f");
      currentCommit = {
        sha,
        authorName,
        authorEmail,
        authoredAt,
        subject
      };

      const commitId = `commit:${sha}`;
      const userId = `git-user:${authorEmail || authorName}`;
      addNode(context, {
        id: commitId,
        type: "Commit",
        label: sha.slice(0, 7),
        parentId: repoId,
        data: {
          sha,
          authorName,
          authorEmail,
          authoredAt,
          subject
        }
      });
      addNode(context, {
        id: userId,
        type: "User",
        label: authorName || authorEmail || "Unknown",
        data: {
          email: authorEmail || undefined
        }
      });
      addEdge(context, repoId, commitId, "contains");
      addEdge(context, commitId, userId, "authored_by");

      const contributorKey = authorEmail || authorName;
      const contributor = context.contributors.get(contributorKey) ?? {
        name: authorName || authorEmail || "Unknown",
        email: authorEmail || undefined,
        commits: 0
      };
      contributor.commits += 1;
      context.contributors.set(contributorKey, contributor);
      continue;
    }

    if (!currentCommit) {
      continue;
    }

    const relativePath = line.trim().replace(/\\/g, "/");
    const fileId = context.fileIdsByPath.get(relativePath);

    if (!fileId) {
      continue;
    }

    const stats = context.fileStats.get(fileId);
    if (!stats) {
      continue;
    }

    stats.commits += 1;
    if (!stats.lastTouchedAt) {
      stats.lastTouchedAt = currentCommit.authoredAt;
    }
    if (stats.recentCommitIds.length < 5) {
      stats.recentCommitIds.push(`commit:${currentCommit.sha}`);
    }
    const authorKey = currentCommit.authorEmail || currentCommit.authorName;
    stats.authors.set(authorKey, (stats.authors.get(authorKey) ?? 0) + 1);
    context.fileActivity.set(fileId, {
      commits: stats.commits,
      lastTouchedAt: stats.lastTouchedAt
    });

    if (changedEdgeCount < 500) {
      addEdge(context, fileId, `commit:${currentCommit.sha}`, "changed_in", {
        authoredAt: currentCommit.authoredAt
      });
      changedEdgeCount += 1;
    }
  }

  for (const [fileId, stats] of context.fileStats) {
    const totalCommits = stats.commits;

    if (!totalCommits || stats.authors.size === 0) {
      continue;
    }

    const [ownerKey, ownerCommits] = [...stats.authors.entries()].sort((left, right) => right[1] - left[1])[0];
    const contributor = context.contributors.get(ownerKey);

    context.fileOwnership.set(fileId, {
      name: contributor?.name ?? ownerKey,
      email: contributor?.email,
      commits: ownerCommits,
      share: ownerCommits / totalCommits
    });
  }
}

async function collectGitHubData(repoId: string, materialized: MaterializedSource, context: MutableContext): Promise<void> {
  if (materialized.sourceType !== "github" || !materialized.github) {
    return;
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "github-knowledge-graph"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const repoResponse = await fetch(
      `https://api.github.com/repos/${materialized.github.owner}/${materialized.github.repo}`,
      { headers }
    );

    if (repoResponse.ok) {
      const repoInfo = (await repoResponse.json()) as GitHubRepoResponse;
      context.githubSummary = {
        owner: materialized.github.owner,
        repo: materialized.github.repo,
        stars: repoInfo.stargazers_count,
        forks: repoInfo.forks_count,
        openIssues: repoInfo.open_issues_count,
        defaultBranch: repoInfo.default_branch,
        url: repoInfo.html_url
      };
    }
  } catch {
    context.githubSummary = undefined;
  }

  try {
    const issuesResponse = await fetch(
      `https://api.github.com/repos/${materialized.github.owner}/${materialized.github.repo}/issues?state=open&per_page=12`,
      { headers }
    );

    if (!issuesResponse.ok) {
      return;
    }

    const issues = (await issuesResponse.json()) as GitHubIssueResponse[];

    for (const item of issues) {
      const nodeType = item.pull_request ? "PullRequest" : "Issue";
      const nodeId = `${nodeType === "PullRequest" ? "pull" : "issue"}:${item.number}`;
      const userLogin = item.user?.login ?? "unknown";
      const userId = `github-user:${userLogin}`;

      addNode(context, {
        id: nodeId,
        type: nodeType,
        label: `#${item.number} ${item.title}`,
        parentId: repoId,
        data: {
          number: item.number,
          state: item.state,
          url: item.html_url,
          createdAt: item.created_at,
          comments: item.comments
        }
      });
      addNode(context, {
        id: userId,
        type: "User",
        label: userLogin,
        data: {
          login: userLogin
        }
      });
      addEdge(context, repoId, nodeId, "contains");
      addEdge(context, nodeId, userId, "opened_by");

      for (const assignee of item.assignees ?? []) {
        const assigneeId = `github-user:${assignee.login}`;
        addNode(context, {
          id: assigneeId,
          type: "User",
          label: assignee.login,
          data: {
            login: assignee.login
          }
        });
        addEdge(context, nodeId, assigneeId, "assignee");
      }

      if (item.comments > 0) {
        await collectGitHubComments(nodeId, item.comments_url, headers, context);
      }
    }
  } catch {
    return;
  }
}

async function collectGitHubComments(
  parentId: string,
  commentsUrl: string,
  headers: Record<string, string>,
  context: MutableContext
): Promise<void> {
  try {
    const response = await fetch(`${commentsUrl}?per_page=3`, { headers });

    if (!response.ok) {
      return;
    }

    const comments = (await response.json()) as GitHubCommentResponse[];

    for (const comment of comments) {
      const commentId = `comment:${comment.id}`;
      const userLogin = comment.user?.login ?? "unknown";
      const userId = `github-user:${userLogin}`;

      addNode(context, {
        id: commentId,
        type: "Comment",
        label: `${userLogin} commented`,
        parentId,
        data: {
          createdAt: comment.created_at,
          url: comment.html_url,
          bodyPreview: comment.body?.slice(0, 160) ?? ""
        }
      });
      addNode(context, {
        id: userId,
        type: "User",
        label: userLogin,
        data: {
          login: userLogin
        }
      });
      addEdge(context, commentId, parentId, "comment_on");
      addEdge(context, commentId, userId, "authored_by");
    }
  } catch {
    return;
  }
}

function buildSummary(
  materialized: MaterializedSource,
  generatedAt: string,
  context: MutableContext,
  insights: Record<string, ReturnType<typeof generateInsights>[string]>
): RepoSummary {
  const counts = {
    nodes: context.nodes.length,
    edges: context.edges.length,
    files: context.nodes.filter((node) => node.type === "File").length,
    directories: context.nodes.filter((node) => node.type === "Directory").length,
    functions: context.nodes.filter((node) => node.type === "Function" || node.type === "Method").length,
    dependencies: context.nodes.filter((node) => node.type === "Dependency").length,
    commits: context.nodes.filter((node) => node.type === "Commit").length,
    issues: context.nodes.filter((node) => node.type === "Issue").length,
    pullRequests: context.nodes.filter((node) => node.type === "PullRequest").length
  };

  const childCounts = new Map<string, number>();
  for (const edge of context.edges) {
    if (edge.type !== "contains") {
      continue;
    }

    childCounts.set(edge.source, (childCounts.get(edge.source) ?? 0) + 1);
  }

  const topDirectories = context.nodes
    .filter((node) => node.type === "Directory")
    .map((node) => ({
      id: node.id,
      label: node.label,
      children: childCounts.get(node.id) ?? 0
    }))
    .sort((left, right) => right.children - left.children)
    .slice(0, 6);

  const topContributors = [...context.contributors.values()]
    .sort((left, right) => right.commits - left.commits)
    .slice(0, 5);

  const noTestCount = Object.values(insights)
    .flat()
    .filter((insight) => insight.title === "No tests").length;
  const orphanCount = Object.values(insights)
    .flat()
    .filter((insight) => insight.title === "Orphan").length;
  const bottlenecks = Object.entries(insights)
    .flatMap(([nodeId, nodeInsights]) =>
      nodeInsights
        .filter((insight) => insight.title === "Bottleneck")
        .map(() => context.nodeMap.get(nodeId))
        .filter((node): node is GraphNode => Boolean(node))
    )
    .slice(0, 3);

  const entryPointLabels = [...context.entryPointIds]
    .map((nodeId) => context.nodeMap.get(nodeId))
    .filter((node): node is GraphNode => Boolean(node))
    .map((node) => node.path ?? node.label)
    .slice(0, 6);

  const alerts: string[] = [];
  if (noTestCount > 0) {
    alerts.push(`${noTestCount} code files appear to have no matching tests.`);
  }
  if (orphanCount > 0) {
    alerts.push(`${orphanCount} files or symbols are disconnected from the active import/call graph.`);
  }
  if (counts.commits === 0) {
    alerts.push("Git history was not available for this source, so activity insights are partial.");
  }
  if (context.githubSummary) {
    alerts.push(
      `${context.githubSummary.owner}/${context.githubSummary.repo} has ${context.githubSummary.stars} stars and ${context.githubSummary.openIssues} open issues.`
    );
  }

  const narratives: RepoNarrative[] = [
    {
      id: "run",
      title: "How do I run this repo?",
      description:
        context.packageScripts.length > 0
          ? `Start with package scripts like ${context.packageScripts
              .slice(0, 3)
              .map((script) => `${script.packageName}:${script.scriptName}`)
              .join(", ")}.`
          : entryPointLabels.length > 0
            ? `Primary entry points look like ${entryPointLabels.slice(0, 3).join(", ")}.`
            : "No package scripts were found, so inspect the detected entry files.",
      nodeIds: [...context.entryPointIds].slice(0, 4)
    },
    {
      id: "risk",
      title: "What is risky to change?",
      description:
        bottlenecks.length > 0
          ? `Watch ${bottlenecks.map((node) => node.label).join(", ")} first because many nodes flow through them.`
          : "No obvious bottlenecks were detected in the current subgraph.",
      nodeIds: bottlenecks.map((node) => node.id)
    },
    {
      id: "owners",
      title: "Who knows this repo?",
      description:
        topContributors.length > 0
          ? `Recent activity is concentrated around ${topContributors
              .slice(0, 3)
              .map((person) => person.name)
              .join(", ")}.`
          : "No contributor history was available for this source.",
      nodeIds: topContributors
        .map((person) => `git-user:${person.email || person.name}`)
        .filter((nodeId) => context.nodeMap.has(nodeId))
    }
  ];

  return {
    source: materialized.source,
    sourceType: materialized.sourceType,
    resolvedPath: materialized.rootPath,
    repoName: materialized.repoName,
    ref: materialized.ref,
    headSha: materialized.headSha,
    generatedAt,
    counts,
    alerts,
    topDirectories,
    topContributors,
    entryPoints: entryPointLabels,
    narratives,
    github: context.githubSummary
  };
}

function applyMetrics(context: MutableContext): void {
  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();

  for (const edge of context.edges) {
    outboundCounts.set(edge.source, (outboundCounts.get(edge.source) ?? 0) + 1);
    inboundCounts.set(edge.target, (inboundCounts.get(edge.target) ?? 0) + 1);
  }

  for (const node of context.nodes) {
    const stats = context.fileStats.get(node.id);
    node.metrics = {
      inbound: inboundCounts.get(node.id) ?? 0,
      outbound: outboundCounts.get(node.id) ?? 0,
      size: stats?.size,
      commits: stats?.commits,
      lastTouchedAt: stats?.lastTouchedAt ?? stats?.lastModified
    };
  }
}

function buildTestMatches(fileIdsByPath: Map<string, string>): Map<string, string[]> {
  const testFilesByStem = new Map<string, string[]>();
  const matches = new Map<string, string[]>();

  for (const [relativePath, fileId] of fileIdsByPath) {
    if (!isTestFile(relativePath)) {
      continue;
    }

    const key = normalizeStem(relativePath, true);
    if (!testFilesByStem.has(key)) {
      testFilesByStem.set(key, []);
    }
    testFilesByStem.get(key)?.push(fileId);
  }

  for (const [relativePath, fileId] of fileIdsByPath) {
    if (!isCodeFile(relativePath) || isTestFile(relativePath)) {
      continue;
    }

    matches.set(fileId, testFilesByStem.get(normalizeStem(relativePath, false)) ?? []);
  }

  return matches;
}

function normalizeStem(relativePath: string, isTest: boolean): string {
  const withoutExtension = relativePath.replace(/\.[^.]+$/, "");
  const withoutMarkers = withoutExtension.replace(/\.(test|spec)$/i, "");
  const normalized = withoutMarkers
    .replace(/(^|\/)(src|lib|app|tests?|__tests__)(\/|$)/gi, "/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .toLowerCase();

  return isTest ? normalized : normalized;
}

function ensureDependencyNode(context: MutableContext, name: string, version?: string): string {
  if (context.dependencyIds.has(name)) {
    const existingId = context.dependencyIds.get(name) as string;

    if (version) {
      const node = context.nodeMap.get(existingId);
      if (node) {
        const versions = new Set<string>(Array.isArray(node.data.versions) ? (node.data.versions as string[]) : []);
        versions.add(version);
        node.data.versions = [...versions];
      }
    }

    return existingId;
  }

  const dependencyId = `dependency:${name}`;
  addNode(context, {
    id: dependencyId,
    type: "Dependency",
    label: name,
    data: {
      packageName: name,
      versions: version ? [version] : []
    }
  });
  context.dependencyIds.set(name, dependencyId);
  return dependencyId;
}

function addNode(context: MutableContext, node: GraphNode): void {
  const existing = context.nodeMap.get(node.id);

  if (existing) {
    existing.label = node.label || existing.label;
    existing.path = node.path ?? existing.path;
    existing.parentId = node.parentId ?? existing.parentId;
    existing.data = {
      ...existing.data,
      ...node.data
    };
    return;
  }

  context.nodeMap.set(node.id, node);
  context.nodes.push(node);
}

function annotateNode(context: MutableContext, nodeId: string, data: Record<string, unknown>): void {
  const node = context.nodeMap.get(nodeId);
  if (!node) {
    return;
  }

  node.data = {
    ...node.data,
    ...data
  };
}

function addEdge(
  context: MutableContext,
  source: string,
  target: string,
  type: EdgeType,
  data?: Record<string, unknown>
): void {
  if (source === target) {
    return;
  }

  const key = `${type}:${source}->${target}`;
  if (context.edgeKeys.has(key)) {
    return;
  }

  context.edgeKeys.add(key);
  context.edges.push({
    id: key,
    source,
    target,
    type,
    data
  });
}

async function createIgnoreMatcher(rootPath: string) {
  const matcher = ignore();
  matcher.add(DEFAULT_IGNORES);

  const gitignorePath = path.join(rootPath, ".gitignore");
  try {
    const gitignore = await fs.readFile(gitignorePath, "utf8");
    matcher.add(gitignore);
  } catch {
    return matcher;
  }

  return matcher;
}

function shouldIgnore(matcher: ReturnType<typeof ignore>, relativePath: string, isDirectory: boolean): boolean {
  if (!relativePath) {
    return false;
  }

  return matcher.ignores(isDirectory ? `${relativePath}/` : relativePath) || matcher.ignores(relativePath);
}

function resolveImportTarget(
  rootPath: string,
  absolutePath: string,
  sourceValue: string,
  context: MutableContext
): string | null {
  const localTarget = resolveProjectFileTarget(path.dirname(absolutePath), sourceValue, context.fileIdsByPath, rootPath);

  if (localTarget) {
    return localTarget;
  }

  if (!sourceValue.startsWith(".")) {
    return ensureDependencyNode(context, getPackageName(sourceValue));
  }

  return null;
}

function resolveProjectFileTarget(
  baseDirectory: string,
  specifier: string,
  fileIdsByPath: Map<string, string>,
  rootPath = baseDirectory
): string | null {
  const absoluteTarget = specifier.startsWith("/")
    ? path.join(rootPath, specifier)
    : path.resolve(baseDirectory, specifier);
  const relativeBase = toRelative(rootPath, absoluteTarget);
  const candidates = new Set<string>();

  if (relativeBase) {
    candidates.add(relativeBase);
    for (const extension of JS_TS_EXTENSIONS) {
      candidates.add(`${relativeBase}${extension}`);
      candidates.add(path.posix.join(relativeBase, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (fileIdsByPath.has(candidate)) {
      return fileIdsByPath.get(candidate) ?? null;
    }
  }

  return null;
}

function parseGitHubUrl(source: string): { owner: string; repo: string; ref?: string; url: string } | null {
  try {
    const parsed = new URL(source);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    const ref = parts[2] === "tree" ? parts.slice(3).join("/") : undefined;

    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
      return null;
    }

    if (ref && !isSafeGitRef(ref)) {
      return null;
    }

    return {
      owner,
      repo,
      ref: ref || undefined,
      url: `https://github.com/${owner}/${repo}.git`
    };
  } catch {
    return null;
  }
}

function isSafeGitRef(value: string): boolean {
  if (value.length === 0 || value.length > 256) {
    return false;
  }

  if (
    value.includes("..") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.includes("@")
  ) {
    return false;
  }

  if (/[\s~^:?*\[\]{}]/.test(value)) {
    return false;
  }

  return /^[A-Za-z0-9._/-]+$/.test(value);
}

async function cloneGitHubRepository(
  url: string,
  owner: string,
  repo: string,
  requestedRef?: string
): Promise<{ rootPath: string; ref?: string; headSha?: string }> {
  const repoRoot = path.join(os.tmpdir(), "github-knowledge-graph-cache", "repos");
  const repoSlug = `${owner}__${repo}${requestedRef ? `__${requestedRef.replace(/[^\w.-]+/g, "_")}` : ""}`;
  const rootPath = path.join(repoRoot, repoSlug);

  await fs.mkdir(repoRoot, { recursive: true });

  if (!(await pathExists(path.join(rootPath, ".git")))) {
    const args = ["clone", "--depth", "100"];
    if (requestedRef) {
      args.push("--branch", requestedRef, "--single-branch");
    }
    args.push(url, rootPath);
    await execFileAsync("git", args);
  } else {
    await execFileAsync("git", ["-C", rootPath, "fetch", "--depth", "100", "origin"]);
    if (requestedRef) {
      await execFileAsync("git", ["-C", rootPath, "checkout", requestedRef]);
      await execFileAsync("git", ["-C", rootPath, "pull", "--ff-only", "origin", requestedRef]);
    } else {
      await execFileAsync("git", ["-C", rootPath, "pull", "--ff-only"]);
    }
  }

  const ref = requestedRef ?? (await getGitValue(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? undefined;
  const headSha = await getGitValue(rootPath, ["rev-parse", "HEAD"]);

  return {
    rootPath,
    ref: ref && ref !== "HEAD" ? ref : undefined,
    headSha: headSha ?? undefined
  };
}

async function getGitValue(cwd: string, args: string[], trim = true): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024
    });
    return trim ? stdout.trim() : stdout;
  } catch {
    return null;
  }
}

function findOwner(ownerRanges: SymbolRange[], position?: number | null): string | null {
  if (typeof position !== "number") {
    return null;
  }

  const matches = ownerRanges.filter((range) => position >= range.start && position <= range.end);

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => left.end - left.start - (right.end - right.start));
  return matches[0]?.id ?? null;
}

function getSimpleCalleeName(callee: unknown): string | null {
  if (!callee || typeof callee !== "object" || !("type" in callee)) {
    return null;
  }

  const typed = callee as { type: string; name?: string; property?: { type: string; name?: string } };
  if (typed.type === "Identifier") {
    return typed.name ?? null;
  }

  if (typed.type === "MemberExpression" && typed.property?.type === "Identifier") {
    return typed.property.name ?? null;
  }

  return null;
}

function isTopLevel(parentType?: string): boolean {
  return parentType === "Program" || parentType === "ExportNamedDeclaration" || parentType === "ExportDefaultDeclaration";
}

function getPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }

  return specifier.split("/")[0] ?? specifier;
}

function inferLanguage(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();

  switch (extension) {
    case ".ts":
    case ".tsx":
      return "TypeScript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "JavaScript";
    case ".json":
      return "JSON";
    case ".md":
      return "Markdown";
    case ".py":
      return "Python";
    case ".go":
      return "Go";
    case ".rs":
      return "Rust";
    default:
      return extension ? extension.slice(1).toUpperCase() : "Text";
  }
}

function isCodeFile(relativePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(relativePath);
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(relativePath);
}

function toRelative(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
  return relative === "" ? "." : relative;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function expandHomeDirectory(source: string): string {
  if (source.startsWith("~/")) {
    return path.join(os.homedir(), source.slice(2));
  }

  return source;
}
