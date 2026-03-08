package com.thefortressofthieves.launcher.anticheat;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Scans live JVM thread stack traces for signatures that indicate injected or obfuscated code.
 */
public class ThreadStackScanner {
    private static final Pattern NON_PRINTABLE_PATTERN = Pattern.compile(".*[^\\x20-\\x7E].*");
    private static final Pattern OBFUSCATED_PATTERN = Pattern.compile("^[a-z]{1,2}\\..{10,}");
    private static final List<String> SAFE_PACKAGES = List.of(
        "net.minecraft",
        "cpw.mods",
        "org.lwjgl",
        "java.",
        "javax."
    );

    /**
     * Performs one full stack scan using {@link Thread#getAllStackTraces()}.
     *
     * @return scan result containing suspicious classes, threads, and findings.
     */
    public ScanResult scan() {
        Set<String> suspiciousClasses = new LinkedHashSet<>();
        Set<String> suspiciousThreads = new LinkedHashSet<>();
        List<SuspiciousFrame> findings = new ArrayList<>();

        for (Map.Entry<Thread, StackTraceElement[]> entry : Thread.getAllStackTraces().entrySet()) {
            Thread thread = entry.getKey();
            StackTraceElement[] stack = entry.getValue();

            boolean threadNameEmpty = isThreadNameEmpty(thread);
            boolean threadHasSuspiciousFrame = false;

            for (StackTraceElement element : stack) {
                String className = element.getClassName();
                if (isSafePackage(className)) {
                    continue;
                }

                String stackLine = element.toString();
                boolean suspicious = threadNameEmpty
                    || hasNonPrintable(className)
                    || isObfuscated(className)
                    || isUnknownSource(element)
                    || hasShortPackageSegment(className);

                if (suspicious) {
                    threadHasSuspiciousFrame = true;
                    suspiciousClasses.add(className);
                    findings.add(new SuspiciousFrame(thread.getName(), className, stackLine));
                }
            }

            if (threadHasSuspiciousFrame || threadNameEmpty) {
                suspiciousThreads.add(thread.getName());
            }
        }

        return new ScanResult(
            List.copyOf(suspiciousClasses),
            List.copyOf(suspiciousThreads),
            List.copyOf(findings)
        );
    }

    private boolean isThreadNameEmpty(Thread thread) {
        return thread.getName() == null || thread.getName().trim().isEmpty();
    }

    private boolean hasNonPrintable(String className) {
        return NON_PRINTABLE_PATTERN.matcher(className).matches();
    }

    private boolean isObfuscated(String className) {
        return OBFUSCATED_PATTERN.matcher(className).matches();
    }

    private boolean isUnknownSource(StackTraceElement element) {
        return element.getFileName() == null || element.toString().contains("Unknown Source");
    }

    private boolean hasShortPackageSegment(String className) {
        int dotIndex = className.indexOf('.');
        if (dotIndex <= 0) {
            return false;
        }
        String firstSegment = className.substring(0, dotIndex);
        return firstSegment.length() <= 2;
    }

    private boolean isSafePackage(String className) {
        return SAFE_PACKAGES.stream().anyMatch(className::startsWith);
    }

    public record ScanResult(
        List<String> suspiciousClasses,
        List<String> suspiciousThreads,
        List<SuspiciousFrame> suspiciousFrames
    ) {
        public boolean detected() {
            return !suspiciousClasses.isEmpty() || !suspiciousThreads.isEmpty();
        }
    }

    public record SuspiciousFrame(String threadName, String className, String stackLine) {
    }
}
