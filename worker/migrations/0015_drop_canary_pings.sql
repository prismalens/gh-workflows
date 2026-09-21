-- Migration 0015: drops canary_pings; the telemetry canary was removed entirely.

DROP TABLE IF EXISTS canary_pings;
