# Realtime Phase Approval Components

This directory contains the scaffolding for controlling phase transitions with the OpenAI Realtime API.

- `RealtimeController` wraps the low-level transport and emits conversation items and errors through a listener API. It also prepares `response.create` payloads for audio confirmation prompts.
- `PhaseManager` coordinates approval requests, retry logic, and timeout handling while exposing callbacks that the UI or application layer can subscribe to.

The classes are currently transport-agnostic. Inject a concrete implementation of `RealtimeTransport` (for example, a wrapper around `RealtimeAPIClient`) when wiring the flow into the app, and extend the `resolveApproval` tokens as real conversation data is collected.
