# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-06-05

### Added
- Sparkle button in SCM toolbar that invokes `claude --print /commit-msg` and writes the result to the commit input box
- Output channel "Claude Commit" for inspecting CLI errors
- Configurable `claudeCommit.claudePath` and `claudeCommit.timeout` settings
- Cancellable progress notification during generation
- "Show Output" action on error toasts for quick debugging
