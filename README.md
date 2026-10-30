# tldr-tr

A small, dependency-free Node script (Node 18+) that finds tldr pages missing or outdated in Turkish, ranks them, and writes machine-translated drafts into `pages.tr/` for **you to review** before opening a PR.

Per the tldr [AI policy](https://github.com/tldr-pages/tldr/blob/main/contributing-guides/AI-policy.md), machine output must be proofread by a human, and the PR must be opened by you.

## What it does

- **Ranks work** by demand: `(number of other languages that already translated the page + 1) × platform weight` (common 1.0, linux 0.9, osx/windows 0.7, …).
- **Finds outdated pages** where the Turkish examples no longer match the English commands.
- **Applies official wording** from `contributing-guides/translation-templates` with no API calls: "Daha fazla bilgi için", "Ayrıca bakınız", alias pages, "Yardımı görüntüle", `{{yol/dosya}}`, `{{kullanıcı_adı}}`, and so on.
- **Learns from the existing Turkish pages**: reuses human translations of identical English sentences, and placeholder words like `branch_name → dal_ismi`.
- **Updates outdated pages carefully**: it keeps the existing Turkish examples, translates only new ones, and lists removed ones.
- **Converts the verb style** to the informal imperative ("listele", not "listeleyin"), which about 92% of current Turkish pages use. Use `--formal` to turn this off.
- **Writes a review checklist** to `review-notes.md` and runs `tldr-lint` with the same ignore rules as upstream CI.
- **Caches translations** in `.cache/`, so you never pay twice for the same sentence.

## Setup

```bash
git clone https://github.com/omerfuyar/tldr-tr
cd tldr-tr
git remote add upstream https://github.com/tldr-pages/tldr
npm install            # for tldr-lint
```

This tool lives on the `tools` branch of the fork, which shares no history with the tldr pages. Check it out next to the clone:

```bash
git worktree add ../tldr-tr-tools tools
```

Then run it from inside the clone (or pass `--repo`).

## Usage

```bash
node ../tldr-tr-tools/tldr-tr.js plan --limit 30            # what to do next
node ../tldr-tr-tools/tldr-tr.js plan --type alias          # free, template-only pages
node ../tldr-tr-tools/tldr-tr.js plan --status outdated
node ../tldr-tr-tools/tldr-tr.js translate --provider deepl --limit 5
node ../tldr-tr-tools/tldr-tr.js translate --provider deepl --pages common/cd,common/pwd
node ../tldr-tr-tools/tldr-tr.js translate --provider none --limit 5   # no API: you translate the English lines left in place
node ../tldr-tr-tools/tldr-tr.js terms                       # placeholder words in use
```

Add `--dry-run` to print the pages instead of writing them.

## Providers

| Provider | Free allowance | Env vars | Notes |
|---|---|---|---|
| `deepl` | 500k chars/month | `DEEPL_API_KEY` | Best plain MT quality for Turkish. Uses `glossary.tsv` as a DeepL glossary. |
| `azure` | 2M chars/month | `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` | Largest free tier. No glossary. |
| `llm` | depends on the API | `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | Any OpenAI-compatible API. Defaults to Gemini's endpoint. Follows style rules and the glossary through the prompt. |
| `none` | – | – | Templates and known wording only. |

All ~7,000 pages are about 1.8M characters. The top 300 `common` pages are about 90k.

## Files you can edit

- `glossary.tsv`: general terminology (directory → dizin, …) for `deepl` and `llm`.
- `placeholders.tsv`: placeholder words (`output_file → çıktı_dosyası`). These win over everything else.

## Suggested PR workflow

```bash
git fetch upstream && git switch -c tr-batch-1 upstream/main
node ../tldr-tr-tools/tldr-tr.js translate --provider deepl --limit 5
# proofread every page, tick off review-notes.md
git add pages.tr && git commit -m "cd, pwd, vim, ...: add Turkish translation"
git push -u origin tr-batch-1    # then open the PR on GitHub yourself
```

Keep the tool out of your PR branches: keep it in its own folder or repo, not inside the tldr clone.
