# Contributing to ZanzoJS

First off, thank you for considering contributing to ZanzoJS! It's people like you who make ZanzoJS such a great tool for the community.

## Getting Started

### Prerequisites
- Node.js >= 20
- pnpm >= 8

### Setup
1. Fork the repository on GitHub.
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/zanzo.git
   cd zanzo
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Verify everything is working by running the tests:
   ```bash
   pnpm test
   ```

## Development Workflow

We follow a standard workflow to keep the codebase clean and stable:

1. **Open an Issue**: Before starting work on any large change, please open an issue to discuss it with the maintainers.
2. **Branching**: Create a new branch from `main` using the following naming convention:
   - `fix/description` for bug fixes
   - `feat/description` for new features
   - `docs/description` for documentation improvements
3. **Implementation**: Make your changes in your branch. Ensure you follow the [Commit Convention](#commit-convention).
4. **Validation**: Run the tests and benchmarks to ensure no regressions:
   ```bash
   pnpm test
   pnpm bench
   ```
5. **Pull Request**: Open a Pull Request against the `main` branch of the original repository.

## Commit Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `fix:` for bug fixes
- `feat:` for new features
- `docs:` for documentation updates
- `test:` for adding or fixing tests
- `chore:` for maintenance tasks, dependencies, etc.

Example: `feat: add support for custom depth limits`

## Pull Request Requirements

To be accepted, a Pull Request must meet these criteria:
- All tests and benchmarks must pass in CI.
- New functionality must include unit tests.
- Changes to the public API must include updates to the documentation.
- A single PR should focus on a single logical change.

## Reporting Bugs

If you find a bug, please use the [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md) in the GitHub issue tracker. Provide as much detail as possible, including steps to reproduce and a minimal code sample.

## Suggesting Features

We love new ideas! Please open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) to discuss your suggestion before spending time on implementation.

---

Thank you for your contributions!
