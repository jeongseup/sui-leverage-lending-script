# Publishing to NPM - DeFi Dash SDK

This guide walks you through the process of publishing `defi-dash-sdk` to the npm registry.

---

## Prerequisites

### 1. NPM Account

- Create an account at [npmjs.com](https://www.npmjs.com/signup) if you don't have one
- Enable 2FA (Two-Factor Authentication) for security

### 2. Package Name Availability

Check if the package name is available:

```bash
npm view defi-dash-sdk
# If it shows "npm ERR! 404", the name is available
```

If the name is taken, consider:

- Scoped package: `@yourorg/defi-dash-sdk`
- Alternative name: `defi-dash`, `sui-defi-sdk`, etc.

---

## Pre-Publishing Checklist

### ✅ Verify Package Configuration

**package.json requirements:**

```json
{
  "name": "defi-dash-sdk",
  "version": "0.1.0",
  "description": "Multi-protocol DeFi SDK for Sui blockchain...",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "keywords": ["sui", "defi", "sdk", "blockchain", "lending"],
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/defi-dash-sdk"
  },
  "license": "ISC"
}
```

**Add keywords for discoverability:**

```bash
npm pkg set keywords='["sui","defi","sdk","blockchain","suilend","scallop","lending","flash-loan"]'
```

**Add repository (recommended):**

```bash
npm pkg set repository.type=git
npm pkg set repository.url="https://github.com/yourusername/defi-dash-sdk"
```

### ✅ Create LICENSE File

```bash
# For ISC License (current)
cat > LICENSE << 'EOF'
ISC License

Copyright (c) 2026 [Your Name]

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
EOF
```

---

## Build & Test

### 1. Clean Build

```bash
# Remove old build artifacts
rm -rf dist/

# Compile TypeScript
npm run build

# Verify output
ls -la dist/
# Should show: index.js, index.d.ts, lib/, etc.
```

### 2. Test Build Output

Create a minimal test script:

```bash
# test.js
const { formatUnits } = require('./dist/index.js');
console.log(formatUnits(1000000, 6)); // Should output: "1"
```

Run test:

```bash
node test.js
```

### 3. Verify Package Contents

```bash
# Dry-run to see what will be published
npm pack --dry-run

# Create actual tarball for inspection
npm pack
# Creates: defi-dash-sdk-0.1.0.tgz

# Inspect contents
tar -tzf defi-dash-sdk-0.1.0.tgz
```

**Expected contents:**

```
package/package.json
package/README.md
package/LICENSE
package/dist/index.js
package/dist/index.d.ts
package/dist/lib/...
```

---

## Publishing Steps

### 1. Login to NPM

```bash
npm login
```

You'll be prompted for:

- **Username**: Your npm username
- **Password**: Your npm password
- **Email**: Public email (visible on npm)
- **OTP**: 2FA code from authenticator app

Verify login:

```bash
npm whoami
# Should display your username
```

### 2. Publish (First Release)

```bash
# Final check
npm run build

# Publish
npm publish
```

**Expected output:**

```
npm notice
npm notice 📦  defi-dash-sdk@0.1.0
npm notice === Tarball Contents ===
npm notice 1.2kB package.json
npm notice 5.4kB README.md
npm notice 1.1kB LICENSE
npm notice 15.2kB dist/index.js
npm notice 1.8kB dist/index.d.ts
...
npm notice === Tarball Details ===
npm notice name:          defi-dash-sdk
npm notice version:       0.1.0
npm notice package size:  25.4 kB
npm notice unpacked size: 45.6 kB
npm notice total files:   12
npm notice
+ defi-dash-sdk@0.1.0
```

### 3. Verify Publication

Visit your package page:

```
https://www.npmjs.com/package/defi-dash-sdk
```

Test installation in a new directory:

```bash
mkdir test-install && cd test-install
npm init -y
npm install defi-dash-sdk

# Test import
node -e "const { formatUnits } = require('defi-dash-sdk'); console.log(formatUnits(1000000, 6))"
# Should output: "1"
```

---

## Publishing Updates

### Version Bumping

Follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.1.0 → 0.1.1): Bug fixes

  ```bash
  npm version patch
  ```

- **Minor** (0.1.0 → 0.2.0): New features (backward compatible)

  ```bash
  npm version minor
  ```

- **Major** (0.1.0 → 1.0.0): Breaking changes
  ```bash
  npm version major
  ```

### Publishing a New Version

```bash
# 1. Make changes
# 2. Commit changes
git add .
git commit -m "feat: add new utility function"

# 3. Bump version (automatically creates git tag)
npm version minor

# 4. Build and publish
npm run build
npm publish

# 5. Push to git (including tags)
git push --follow-tags
```

---

## Publishing Scoped Packages

If the name is taken, use a scoped package:

### 1. Update package.json

```json
{
  "name": "@yourorg/defi-dash-sdk"
}
```

### 2. Publish with public access

```bash
npm publish --access public
```

---

## Troubleshooting

### Error: "Package name already exists"

**Solution:** Use a scoped package or choose a different name

### Error: "You must verify your email"

**Solution:** Check your email and click the verification link from npm

### Error: "402 Payment Required"

**Solution:** Scoped packages require `--access public` flag for free accounts

### Build fails with TypeScript errors

```bash
# Check for errors without building
npx tsc --noEmit

# Fix errors, then rebuild
npm run build
```

### Package too large

```bash
# Check package size
npm pack --dry-run

# Review what's being included
cat .gitignore  # Ensure test files are excluded
cat package.json | grep -A 5 '"files"'
```

**Optimize:**

- Ensure `files` field only includes `dist/`, `README.md`, `LICENSE`
- Remove unnecessary dependencies
- Use `devDependencies` for build tools

---

## Best Practices

### 1. Pre-publish Script

Add to `package.json`:

```json
{
  "scripts": {
    "prepublishOnly": "npm run build && npm test"
  }
}
```

### 2. CI/CD Publishing

Use GitHub Actions for automated publishing:

```yaml
# .github/workflows/publish.yml
name: Publish to NPM

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 3. Changelog

Maintain a `CHANGELOG.md`:

```markdown
# Changelog

## [0.1.0] - 2026-01-16
### Added
- Initial release
- Token formatting utilities
- Coin type normalization
```

### 4. README Badges

Add to README.md:

```markdown
[![npm version](https://img.shields.io/npm/v/defi-dash-sdk.svg)](https://www.npmjs.com/package/defi-dash-sdk)
[![npm downloads](https://img.shields.io/npm/dm/defi-dash-sdk.svg)](https://www.npmjs.com/package/defi-dash-sdk)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
```

---

## Post-Publishing

### 1. Announcement

- Share on Twitter/X with hashtags: `#sui #defi #npm`
- Post in Sui Discord community
- Submit to awesome-sui lists

### 2. Documentation

- Create GitHub repository
- Add examples and tutorials
- Set up GitHub Pages for docs

### 3. Monitoring

- Watch for issues on npm
- Monitor download stats
- Collect user feedback

---

## Quick Reference

```bash
# Complete publishing workflow
npm run build              # Build TypeScript
npm pack --dry-run        # Preview package contents
npm login                 # Login to npm
npm publish               # Publish to registry

# Update workflow
npm version patch         # Bump version
npm run build            # Rebuild
npm publish              # Publish update
git push --follow-tags   # Push to git
```

---

## Support

- **npm Documentation**: https://docs.npmjs.com/
- **Semantic Versioning**: https://semver.org/
- **Package Best Practices**: https://docs.npmjs.com/packages-and-modules
