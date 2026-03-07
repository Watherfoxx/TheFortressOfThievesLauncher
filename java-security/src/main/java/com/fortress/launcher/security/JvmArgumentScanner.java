package com.fortress.launcher.security;

import java.lang.management.ManagementFactory;
import java.lang.management.RuntimeMXBean;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Detects suspicious JVM input arguments linked to code injection.
 */
public class JvmArgumentScanner {

    private static final List<String> SUSPICIOUS_PREFIXES = List.of("-javaagent", "-agentlib", "-agentpath");

    /**
     * @return suspicious JVM arguments from the current runtime.
     */
    public List<String> scan() {
        RuntimeMXBean runtimeMXBean = ManagementFactory.getRuntimeMXBean();
        return runtimeMXBean.getInputArguments().stream()
                .filter(this::isSuspicious)
                .collect(Collectors.toUnmodifiableList());
    }

    private boolean isSuspicious(String argument) {
        String normalized = argument.toLowerCase(Locale.ROOT);
        return SUSPICIOUS_PREFIXES.stream().anyMatch(normalized::startsWith);
    }
}
