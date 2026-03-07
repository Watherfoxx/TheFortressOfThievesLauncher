package com.fortress.launcher.security;

import java.time.Instant;
import java.util.List;

/**
 * Aggregated result of launcher security checks.
 */
public record SecurityReport(
        Instant timestamp,
        List<SuspiciousProcess> suspiciousProcesses,
        List<LoadedModule> suspiciousModules,
        List<String> jvmFlagsDetected
) {

    /**
     * @return true when no suspicious indicators were detected.
     */
    public boolean isClean() {
        return suspiciousProcesses.isEmpty() && suspiciousModules.isEmpty() && jvmFlagsDetected.isEmpty();
    }
}
