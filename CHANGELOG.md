# Changelog

All notable changes to Board are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Foundation application shell, verification tools, and fixture-only preview
  deployment.
- Inventory-bound report validation and shared lane semantics, including branch
  units, active overlap, uncertainty, and empty backlogs.
- Responsive sample reports at `/demo`, safe source links, theme preferences,
  and original backlog report sections.
- Built-asset browser checks with strict CSP and a static artifact verification
  gate in CI.
- Production-only GitHub App sign-in, encrypted owner sessions, eligible
  repository views, and explicit source checks with input provenance.
- Complete bounded source collection, two-pass consistency checks, and
  fingerprints that include issue comments and referenced closed-state metadata.
- Independent backend verification and build composition that removes Functions
  from every nonproduction deployment.
- Owner-only Generate and Refresh actions backed by fixed Opus 5 analysis,
  durable current and previous reports, authenticated cross-device access,
  source provenance, report comparisons, and persistent job and spending guards.
- Deployment-bound no-spend analysis verification plus an authenticated setup
  spending projection and explicit continue or confirmed-stop controls at the
  $20 discussion gate.
