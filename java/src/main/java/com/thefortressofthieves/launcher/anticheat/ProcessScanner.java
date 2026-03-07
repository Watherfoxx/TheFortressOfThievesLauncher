package com.thefortressofthieves.launcher.anticheat;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Scans operating system processes to identify suspicious Java processes that run external JARs.
 */
public class ProcessScanner {
    private final List<String> trustedPathKeywords;

    /**
     * Creates a scanner using default trusted path keywords.
     */
    public ProcessScanner() {
        this(List.of("minecraft", "launcher", "runtime", "jre", "jdk"));
    }

    /**
     * Creates a scanner with explicit trusted path keywords.
     *
     * @param trustedPathKeywords path fragments considered trusted.
     */
    public ProcessScanner(List<String> trustedPathKeywords) {
        this.trustedPathKeywords = new ArrayList<>(trustedPathKeywords);
    }

    /**
     * Returns suspicious Java processes that execute non-trusted JARs.
     *
     * @return suspicious process command lines.
     */
    public List<String> scanSuspiciousProcesses() {
        return ProcessHandle.allProcesses()
            .map(this::toSuspiciousProcess)
            .flatMap(Optional::stream)
            .distinct()
            .collect(Collectors.toList());
    }

    private Optional<String> toSuspiciousProcess(ProcessHandle processHandle) {
        ProcessHandle.Info info = processHandle.info();
        String command = info.command().orElse("");
        if (!command.toLowerCase(Locale.ROOT).contains("java")) {
            return Optional.empty();
        }

        String[] args = info.arguments().orElse(new String[0]);
        if (args.length == 0) {
            return Optional.empty();
        }

        List<String> jarArguments = Arrays.stream(args)
            .filter(arg -> arg.toLowerCase(Locale.ROOT).contains(".jar"))
            .collect(Collectors.toList());

        if (jarArguments.isEmpty()) {
            return Optional.empty();
        }

        boolean hasUntrustedJar = jarArguments.stream().anyMatch(jar -> !isTrustedJar(jar));
        if (!hasUntrustedJar) {
            return Optional.empty();
        }

        String commandLine = info.commandLine().orElseGet(() -> command + " " + String.join(" ", args));
        return Optional.of(commandLine.trim());
    }

    private boolean isTrustedJar(String jarArgument) {
        String normalized = jarArgument.toLowerCase(Locale.ROOT);

        String javaHome = System.getProperty("java.home", "").toLowerCase(Locale.ROOT);
        if (!javaHome.isBlank() && normalized.contains(javaHome)) {
            return true;
        }

        Path currentDir = Path.of("").toAbsolutePath();
        if (normalized.contains(currentDir.toString().toLowerCase(Locale.ROOT))) {
            return true;
        }

        return trustedPathKeywords.stream()
            .map(keyword -> keyword.toLowerCase(Locale.ROOT))
            .anyMatch(normalized::contains);
    }
}
