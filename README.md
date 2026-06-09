# AI Code Review Commenter

This GitHub Action reviews code on `pull_request` or `push` events with an OpenAI-compatible model and writes the result back to GitHub.

- `pull_request`: publishes a PR review summary and inline comments on changed lines
- `push`: publishes a commit-level summary comment
- supports a repository-specific prompt file, so different repos can use different review rules
- supports optional blocking keyword rules in the prompt file front matter
- runs as a JavaScript action on Node.js 24

## Use Cases

This is useful when different repositories need different review priorities, for example:

- a Java service repo that cares about null safety, transactions, and concurrency
- a frontend repo that cares about accessibility, state handling, and performance regressions
- a security-sensitive repo that cares about auth, injection risks, and secret exposure

Each repository can keep its own prompt file and pass that file path into the action.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | - | GitHub token used to read changed files and publish comments |
| `ai-api-key` | Yes | - | API key for the review model provider |
| `ai-base-url` | No | `https://api.openai.com/v1` | Base URL for an OpenAI-compatible API |
| `model` | Yes | - | Model name |
| `prompt-file` | No | `.github/review-prompt.md` | Prompt file path inside the target repository |
| `max-files` | No | `20` | Max changed files to send to the model |
| `max-line-comments` | No | `10` | Max inline PR comments to publish |
| `extra-instructions` | No | `""` | Extra instructions appended after the prompt file |

## Example Workflow

Add a workflow like this in the repository that wants AI review:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Run AI review
        uses: 463975089/ai-code-review@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.OPENAI_API_KEY }}
          ai-base-url: https://api.openai.com/v1
          model: gpt-4.1
          prompt-file: .github/review-prompt.md
```

`fetch-depth: 0` is strongly recommended, especially for `push`, because the action computes diffs between commits.

## Repository Prompt File

Each repository can define its own review prompt, for example `.github/review-prompt.md`:

```md
---
blocking_keywords:
  - amd
  - cuda
blocking_match_mode: content_or_path
blocking_review_event: REQUEST_CHANGES
---

You are the code reviewer for this repository.

Review rules:
- Only comment on real and meaningful issues
- Prioritize bugs, regressions, security issues, performance problems, edge cases, and missing tests
- Avoid style-only comments unless they materially affect maintainability
- Keep comments short, concrete, and actionable

Extra focus:
- For backend code, pay extra attention to exception handling, transactions, concurrency, and logging
- If public behavior changes, remind the author to add or update tests
```

You can also route different teams or repos to different prompt files:

```yaml
with:
  prompt-file: .github/prompts/backend-review.md
```

### Front Matter Rules

The prompt file can start with a simple front matter block. These fields are currently supported:

- `blocking_keywords`: a list of keywords that trigger a deterministic blocking review
- `blocking_match_mode`: `content`, `path`, or `content_or_path`
- `blocking_review_event`: PR review event to submit when a blocking keyword is matched, usually `REQUEST_CHANGES`

If a PR matches any configured blocking keyword, the action will still run the AI review, but the PR review event will be changed from `COMMENT` to the configured blocking event. This is more reliable than depending on the model to notice and enforce the rule on its own.

For `content` matching, the action only checks newly added diff lines. It does not scan unchanged old code in the file.

## Behavior

### Pull Request

For PRs, the action:

- reads the changed files from the GitHub PR API
- sends patches and current file content to the model
- asks the model for structured JSON output
- only publishes inline comments on lines that were actually added in the PR
- publishes one PR review summary
- if blocking keywords are matched, submits the PR review with `REQUEST_CHANGES` instead of a normal comment review

### Push

For pushes, the action:

- computes the diff between `before` and `after`
- generates a summary review
- publishes one commit comment

## Known Limits

- inline comments only work on changed added lines
- binary files, very large diffs, and very large files are truncated
- invalid model line numbers are dropped automatically
- `push` reviews are less rich than `pull_request` reviews
- blocking keyword matching is simple substring matching
- content keyword matching only checks newly added diff lines
- some reasoning models may still return non-JSON output formats that need provider-side tuning

## Recommended Permissions

```yaml
permissions:
  contents: write
  pull-requests: write
```

## Extension Ideas

This action is a good base if you later want to add:

- severity-based formatting
- ignore paths or file globs
- prompt routing by branch, directory, or file type
- language-specific review policies
- custom output schemas
