package com.fortress.launcher.security;

/**
 * Represents a process flagged as suspicious by the process scanner.
 */
public record SuspiciousProcess(long pid, String name, String path, String reason) {
}
