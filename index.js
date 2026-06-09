"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function getInput(name, options = {}) {
  const candidateKeys = [
    `INPUT_${name.toUpperCase()}`,
    `INPUT_${name.replace(/ /g, "_").toUpperCase()}`,
    `INPUT_${name.replace(/-/g, "_").toUpperCase()}`,
    `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`,
  ];
  const value = candidateKeys
    .map((key) => process.env[key])
    .find((item) => item !== undefined && item !== "");
  if ((value === undefined || value === "") && options.required) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value ?? "";
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stdout.write(`::warning::${message}\n`);
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`);
  process.exitCode = 1;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRepoPath(workspace, relativePath) {
  const workspaceRoot = path.resolve(workspace);
  const resolvedPath = path.resolve(workspace, relativePath);
  if (!resolvedPath.startsWith(workspaceRoot)) {
    throw new Error(`Path must stay inside the repository: ${relativePath}`);
  }
  return resolvedPath;
}

function parseScalarValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontMatter(frontMatterText) {
  const config = {};
  let currentListKey = null;

  for (const rawLine of frontMatterText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.trim().startsWith("#")) {
      continue;
    }

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      config[currentListKey].push(parseScalarValue(listItem[1]));
      continue;
    }

    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) {
      currentListKey = null;
      continue;
    }

    const key = keyValue[1];
    const value = keyValue[2];
    if (value === "") {
      config[key] = [];
      currentListKey = key;
      continue;
    }

    config[key] = parseScalarValue(value);
    currentListKey = null;
  }

  return config;
}

function readPrompt(workspace, promptFile, extraInstructions) {
  const resolvedPath = resolveRepoPath(workspace, promptFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Prompt file not found: ${promptFile}`);
  }

  const fileText = fs.readFileSync(resolvedPath, "utf8");
  const frontMatterMatch = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const promptConfig = frontMatterMatch ? parseFrontMatter(frontMatterMatch[1]) : {};
  const promptBody = (frontMatterMatch ? frontMatterMatch[2] : fileText).trim();

  return {
    config: promptConfig,
    promptText: [promptBody, extraInstructions.trim()].filter(Boolean).join("\n\n"),
  };
}

function runGit(args, workspace) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function githubRequest(token, method, urlPath, body) {
  const response = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ai-code-review-commenter",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${urlPath} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function paginateGithub(token, urlPath) {
  const items = [];
  let page = 1;

  while (true) {
    const separator = urlPath.includes("?") ? "&" : "?";
    const pageItems = await githubRequest(token, "GET", `${urlPath}${separator}per_page=100&page=${page}`);
    items.push(...pageItems);
    if (pageItems.length < 100) {
      return items;
    }
    page += 1;
  }
}

function parsePatchLines(patch) {
  const linesByPath = new Set();
  if (!patch) {
    return linesByPath;
  }

  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      linesByPath.add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    newLine += 1;
  }

  return linesByPath;
}

function getAddedLinesText(patch) {
  if (!patch) {
    return "";
  }

  const addedLines = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push(line.slice(1));
    }
  }
  return addedLines.join("\n");
}

function tryReadFile(workspace, relativePath) {
  const fullPath = resolveRepoPath(workspace, relativePath);
  if (!fullPath) {
    return null;
  }
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return null;
  }
  return fs.readFileSync(fullPath, "utf8");
}

function getBlockingPolicy(promptConfig) {
  const rawKeywords = Array.isArray(promptConfig.blocking_keywords) ? promptConfig.blocking_keywords : [];
  const keywords = rawKeywords
    .map((item) => String(item).trim())
    .filter(Boolean);
  const matchMode = String(promptConfig.blocking_match_mode || "content_or_path").trim().toLowerCase();
  const reviewEvent = String(promptConfig.blocking_review_event || "REQUEST_CHANGES").trim().toUpperCase();

  return {
    keywords,
    matchMode,
    reviewEvent: ["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(reviewEvent) ? reviewEvent : "REQUEST_CHANGES",
  };
}

function buildReviewPayload(files, promptText, eventName) {
  const systemPrompt = [
    "You are a senior software engineer performing code review.",
    "Focus on bugs, regressions, security, performance, maintainability, and missing tests.",
    "Only comment when there is a concrete issue or materially useful suggestion.",
    "Be concise and actionable.",
    "Only produce JSON.",
  ].join(" ");

  const reviewRequest = {
    event_name: eventName,
    instructions: promptText,
    response_schema: {
      summary: "string",
      line_comments: [
        {
          path: "string",
          line: "number",
          body: "string",
          severity: "low|medium|high",
        },
      ],
    },
    files,
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(reviewRequest, null, 2),
  };
}

function truncate(text, maxLength) {
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... [truncated]`;
}

async function callReviewModel(baseUrl, apiKey, model, payload) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: payload.systemPrompt },
        { role: "user", content: payload.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  const cleaned = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function getPullRequestFiles(token, repoFullName, pullNumber) {
  const files = await paginateGithub(token, `/repos/${repoFullName}/pulls/${pullNumber}/files`);
  return files.map((file) => ({
    path: file.filename,
    status: file.status,
    patch: file.patch || "",
    changedLines: parsePatchLines(file.patch || ""),
  }));
}

function getPushFiles(workspace, beforeSha, afterSha) {
  if (!beforeSha || /^0+$/.test(beforeSha)) {
    warn("Push event has no usable base SHA. Skipping review.");
    return [];
  }

  const names = runGit(["diff", "--name-only", beforeSha, afterSha], workspace)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return names.map((filePath) => {
    const patch = runGit(["diff", "--unified=0", beforeSha, afterSha, "--", filePath], workspace);
    return {
      path: filePath,
      status: "modified",
      patch,
      changedLines: parsePatchLines(patch),
    };
  });
}

function hydrateFilesForModel(workspace, changedFiles, maxFiles) {
  return changedFiles.slice(0, maxFiles).map((file) => ({
    path: file.path,
    status: file.status,
    patch: truncate(file.patch, 12000),
    content: truncate(tryReadFile(workspace, file.path) || "", 16000),
  }));
}

function matchesByMode(keyword, matchMode, file, workspace) {
  const normalizedKeyword = keyword.toLowerCase();
  const pathText = file.path.toLowerCase();
  const addedLinesText = getAddedLinesText(file.patch).toLowerCase();

  if (matchMode === "path") {
    return pathText.includes(normalizedKeyword);
  }
  if (matchMode === "content") {
    return addedLinesText.includes(normalizedKeyword);
  }
  return pathText.includes(normalizedKeyword) || addedLinesText.includes(normalizedKeyword);
}

function detectBlockingMatches(changedFiles, workspace, blockingPolicy) {
  if (blockingPolicy.keywords.length === 0) {
    return [];
  }

  const matches = [];
  for (const file of changedFiles) {
    const matchedKeywords = blockingPolicy.keywords.filter((keyword) =>
      matchesByMode(keyword, blockingPolicy.matchMode, file, workspace)
    );

    if (matchedKeywords.length > 0) {
      matches.push({
        path: file.path,
        keywords: matchedKeywords,
      });
    }
  }

  return matches;
}

function normalizeReviewResult(result, changedFiles, maxLineComments) {
  const lineMap = new Map(changedFiles.map((file) => [file.path, file.changedLines]));
  const summary = typeof result.summary === "string" ? result.summary.trim() : "AI review completed.";
  const lineComments = Array.isArray(result.line_comments) ? result.line_comments : [];

  const acceptedComments = [];
  for (const item of lineComments) {
    if (!item || typeof item.path !== "string" || typeof item.line !== "number" || typeof item.body !== "string") {
      continue;
    }
    const changedLines = lineMap.get(item.path);
    if (!changedLines || !changedLines.has(item.line)) {
      continue;
    }
    acceptedComments.push({
      path: item.path,
      line: item.line,
      body: formatInlineComment(item.body.trim(), item.severity),
    });
    if (acceptedComments.length >= maxLineComments) {
      break;
    }
  }

  return { summary, lineComments: acceptedComments };
}

function formatInlineComment(body, severity) {
  const prefix = severity ? `**${String(severity).toUpperCase()}**: ` : "";
  return `${prefix}${body}`;
}

function buildReviewBody(summary, lineCommentsCount) {
  const header = "## AI Code Review";
  const footer = lineCommentsCount > 0
    ? `\n\nPublished ${lineCommentsCount} inline comment(s).`
    : "\n\nNo inline comments were published.";
  return `${header}\n\n${summary}${footer}`;
}

async function publishPullRequestReview(token, repoFullName, pullNumber, headSha, review, reviewEvent) {
  const body = {
    event: reviewEvent,
    commit_id: headSha,
    body: buildReviewBody(review.summary, review.lineComments.length),
    comments: review.lineComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  };

  await githubRequest(token, "POST", `/repos/${repoFullName}/pulls/${pullNumber}/reviews`, body);
}

async function publishCommitComment(token, repoFullName, sha, review) {
  await githubRequest(token, "POST", `/repos/${repoFullName}/commits/${sha}/comments`, {
    body: buildReviewBody(review.summary, 0),
  });
}

async function main() {
  try {
    const githubToken = getInput("github-token", { required: true });
    const apiKey = getInput("ai-api-key", { required: true });
    const baseUrl = getInput("ai-base-url") || "https://api.openai.com/v1";
    const model = getInput("model", { required: true });
    const promptFile = getInput("prompt-file") || ".github/review-prompt.md";
    const extraInstructions = getInput("extra-instructions");
    const maxFiles = Number(getInput("max-files") || "20");
    const maxLineComments = Number(getInput("max-line-comments") || "10");

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const eventName = process.env.GITHUB_EVENT_NAME;
    const repoFullName = process.env.GITHUB_REPOSITORY;
    const eventPath = process.env.GITHUB_EVENT_PATH;

    if (!eventName || !repoFullName || !eventPath) {
      throw new Error("Missing GitHub runtime environment variables");
    }

    const event = readJson(eventPath);
    const { config: promptConfig, promptText } = readPrompt(workspace, promptFile, extraInstructions);
    const blockingPolicy = getBlockingPolicy(promptConfig);

    let changedFiles = [];
    let targetSha = "";
    let pullNumber = null;

    if (eventName === "pull_request" || eventName === "pull_request_target") {
      pullNumber = event.pull_request?.number;
      targetSha = event.pull_request?.head?.sha || "";
      changedFiles = await getPullRequestFiles(githubToken, repoFullName, pullNumber);
    } else if (eventName === "push") {
      targetSha = event.after || "";
      changedFiles = getPushFiles(workspace, event.before, event.after);
    } else {
      log(`Event ${eventName} is not supported. Exiting without review.`);
      return;
    }

    if (changedFiles.length === 0) {
      log("No changed files found for review. Exiting.");
      return;
    }

    const blockingMatches = detectBlockingMatches(changedFiles, workspace, blockingPolicy);
    const filesForModel = hydrateFilesForModel(workspace, changedFiles, maxFiles);
    const payload = buildReviewPayload(filesForModel, promptText, eventName);
    const reviewResult = await callReviewModel(baseUrl, apiKey, model, payload);
    const review = normalizeReviewResult(reviewResult, changedFiles, maxLineComments);
    const blockingSummary = blockingMatches.length > 0
      ? [
          `Blocking policy matched ${blockingMatches.length} file(s).`,
          ...blockingMatches.slice(0, 10).map((match) => `- \`${match.path}\`: ${match.keywords.join(", ")}`),
        ].join("\n")
      : "";
    const finalReview = {
      ...review,
      summary: [blockingSummary, review.summary].filter(Boolean).join("\n\n"),
    };
    const reviewEvent = blockingMatches.length > 0 ? blockingPolicy.reviewEvent : "COMMENT";

    if (pullNumber) {
      await publishPullRequestReview(githubToken, repoFullName, pullNumber, targetSha, finalReview, reviewEvent);
      log(`Published PR review with ${finalReview.lineComments.length} inline comment(s).`);
      return;
    }

    await publishCommitComment(githubToken, repoFullName, targetSha, finalReview);
    log("Published push review summary comment.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
