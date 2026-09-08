import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultIgnoredDirectories = new Set([
  ".git",
  ".gstack",
  ".statecraft",
  ".uiwitness",
  "coverage",
  "dist",
  "node_modules",
  "statecraft-project-docs",
]);
const defaultRequiredFiles = [
  "README.md",
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/customer_pilot_feedback.yml",
  ".github/ISSUE_TEMPLATE/feature_evidence.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "codex/MASTER_PROMPT.md",
  "codex/IMPLEMENTATION_SPEC.md",
  "docs/product/PRD.md",
  "docs/architecture/ARCHITECTURE.md",
  "docs/engineering/IMPLEMENTATION_PLAN.md",
  "docs/engineering/SECURITY_PRIVACY.md",
  "docs/engineering/TEST_STRATEGY.md",
];

async function collectMarkdownFiles(directory, ignoredDirectories) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath, ignoredDirectories)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractInlineTargets(contents) {
  const targets = [];
  const openingPattern = /!?\[[^\]]*\]\(/gu;

  for (const opening of contents.matchAll(openingPattern)) {
    const targetStart = opening.index + opening[0].length;
    if (contents[targetStart] === "<") {
      const closingAngle = contents.indexOf(">", targetStart + 1);
      if (closingAngle !== -1) {
        targets.push({ target: contents.slice(targetStart + 1, closingAngle), index: opening.index });
      }
      continue;
    }

    let depth = 1;
    let targetEnd = targetStart;
    let whitespaceAtDepthOne = -1;
    for (; targetEnd < contents.length; targetEnd += 1) {
      const character = contents[targetEnd];
      if (/\s/u.test(character) && depth === 1 && whitespaceAtDepthOne === -1) {
        whitespaceAtDepthOne = targetEnd;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }

    if (depth === 0) {
      const end = whitespaceAtDepthOne === -1 ? targetEnd : whitespaceAtDepthOne;
      targets.push({ target: contents.slice(targetStart, end), index: opening.index });
    }
  }

  return targets;
}

function maskMarkdownCode(contents) {
  let fenceCharacter;

  return contents
    .split("\n")
    .map((line) => {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        if (!fenceCharacter) {
          fenceCharacter = fence[0];
        } else if (fence[0] === fenceCharacter) {
          fenceCharacter = undefined;
        }
        return " ".repeat(line.length);
      }
      if (fenceCharacter) {
        return " ".repeat(line.length);
      }

      return line.replace(/(`+)([^`\n]*?)\1/gu, (match) => " ".repeat(match.length));
    })
    .join("\n");
}

function extractReferenceLinks(contents) {
  const definitions = new Map();
  const definitionPattern = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gmu;
  for (const match of contents.matchAll(definitionPattern)) {
    definitions.set(match[1].trim().toLowerCase(), {
      target: match[2].replace(/^<|>$/gu, ""),
      index: match.index,
    });
  }

  const usages = [];
  const usagePattern = /!?\[([^\]]+)\]\[([^\]]*)\]/gu;
  for (const match of contents.matchAll(usagePattern)) {
    const key = (match[2] || match[1]).trim().toLowerCase();
    usages.push({ key, index: match.index });
  }

  return { definitions, usages };
}

async function validateTarget({ absoluteFile, contents, index, root, target, errors }) {
  const relativeFile = path.relative(root, absoluteFile);
  const lineNumber = contents.slice(0, index).split("\n").length;
  if (!target || target.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(target)) {
    return;
  }

  let decodedTarget;
  try {
    decodedTarget = decodeURIComponent(target.split("#", 1)[0]);
  } catch {
    errors.push(`${relativeFile}:${lineNumber}: invalid URL encoding in ${target}`);
    return;
  }

  const resolvedTarget = decodedTarget.startsWith("/")
    ? path.join(root, decodedTarget.slice(1))
    : path.resolve(path.dirname(absoluteFile), decodedTarget);

  if (!(await exists(resolvedTarget))) {
    errors.push(`${relativeFile}:${lineNumber}: broken link to ${decodedTarget}`);
  }
}

export async function checkDocs({
  root = process.cwd(),
  ignoredDirectories = defaultIgnoredDirectories,
  requiredFiles = defaultRequiredFiles,
} = {}) {
  const errors = [];

  for (const requiredFile of requiredFiles) {
    if (!(await exists(path.join(root, requiredFile)))) {
      errors.push(`${requiredFile}: required documentation file is missing`);
    }
  }

  const markdownFiles = await collectMarkdownFiles(root, ignoredDirectories);
  for (const absoluteFile of markdownFiles) {
    const relativeFile = path.relative(root, absoluteFile);
    const contents = await readFile(absoluteFile, "utf8");

    if (!contents.startsWith("# ")) {
      errors.push(`${relativeFile}: document must start with one level-one heading`);
    }
    if (!contents.endsWith("\n")) {
      errors.push(`${relativeFile}: file must end with a newline`);
    }

    for (const [index, line] of contents.split("\n").entries()) {
      if (/[ \t]+$/u.test(line)) {
        errors.push(`${relativeFile}:${index + 1}: trailing whitespace`);
      }
    }

    const linkableContents = maskMarkdownCode(contents);
    for (const link of extractInlineTargets(linkableContents)) {
      await validateTarget({ absoluteFile, contents, root, errors, ...link });
    }

    const { definitions, usages } = extractReferenceLinks(linkableContents);
    for (const usage of usages) {
      const definition = definitions.get(usage.key);
      if (!definition) {
        const lineNumber = contents.slice(0, usage.index).split("\n").length;
        errors.push(`${relativeFile}:${lineNumber}: undefined link reference ${usage.key}`);
      }
    }
    for (const definition of definitions.values()) {
      await validateTarget({ absoluteFile, contents, root, errors, ...definition });
    }
  }

  return { errors, filesChecked: markdownFiles.length };
}

async function main() {
  const result = await checkDocs();
  if (result.errors.length > 0) {
    console.error(`Documentation checks failed (${result.errors.length}):`);
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Documentation checks passed (${result.filesChecked} files).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
