# .github/workflows/update-burn.yml
name: Update burn & price

on:
  schedule:
    - cron: "0 0 * * *"   # ogni 24h alle 00:00 UTC
  workflow_dispatch:

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Run burn script
        env:
          HELIUS_API_KEY: ${{ secrets.HELIUS_API_KEY }}
        run: node scripts/burn.js

      - name: Run price script (tollerante)
        run: node scripts/price.js
        continue-on-error: true

      - name: Show outputs
        run: |
          echo "=== data/burn.json ==="; sed -n '1,200p' data/burn.json || true
          echo "=== data/price.json ==="; sed -n '1,200p' data/price.json || true

      - name: Commit & push
        run: |
          git add data/burn.json data/price.json
          if git diff --cached --quiet; then
            echo "No changes to commit."
          else
            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git commit -m "Update burn & price [skip ci]"
            git push
          fi
