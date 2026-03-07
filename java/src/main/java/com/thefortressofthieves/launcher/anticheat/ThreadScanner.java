package com.thefortressofthieves.launcher.anticheat;

import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Scans JVM thread stack traces to identify suspicious class names.
 */
public class ThreadScanner {
    private final Pattern suspiciousPattern;

    /**
     * Creates a scanner with the default suspicious class name pattern.
     */
    public ThreadScanner() {
        this(Pattern.compile("^[a-z]{1,2}\\.[a-z0-9]{10,}$"));
    }

    /**
     * Creates a scanner with a custom suspicious class name pattern.
     *
     * @param suspiciousPattern regex used to identify suspicious class names.
     */
    public ThreadScanner(Pattern suspiciousPattern) {
        this.suspiciousPattern = suspiciousPattern;
    }

    /**
     * Returns suspicious class names detected in stack traces.
     *
     * @return list of suspicious class names.
     */
    public List<String> scanSuspiciousClasses() {
        Set<String> suspiciousClasses = ConcurrentHashMap.newKeySet();

        Thread.getAllStackTraces().values().forEach(stackTraceElements -> {
            for (StackTraceElement element : stackTraceElements) {
                String className = element.getClassName();
                if (suspiciousPattern.matcher(className).matches()) {
                    suspiciousClasses.add(className);
                }
            }
        });

        return suspiciousClasses.stream().sorted().toList();
    }
}
