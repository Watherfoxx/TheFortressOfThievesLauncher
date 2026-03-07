package com.fortress.launcher.security;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Scans system processes using {@link ProcessHandle} metadata and flags suspicious entries.
 */
public class ProcessScanner {

    private final Set<String> suspiciousKeywords;

    public ProcessScanner(Collection<String> suspiciousKeywords) {
        this.suspiciousKeywords = suspiciousKeywords.stream()
                .map(keyword -> keyword.toLowerCase(Locale.ROOT))
                .collect(Collectors.toUnmodifiableSet());
    }

    /**
     * Enumerates all running processes and returns suspicious matches.
     */
    public List<SuspiciousProcess> scan() {
        List<SuspiciousProcess> findings = new ArrayList<>();

        ProcessHandle.allProcesses().forEach(processHandle -> {
            ProcessHandle.Info info = processHandle.info();
            String command = info.command().orElse("");
            String commandLine = info.commandLine().orElse("");
            String arguments = String.join(" ", info.arguments().orElse(new String[0]));

            String combined = (command + " " + commandLine + " " + arguments).toLowerCase(Locale.ROOT);
            suspiciousKeywords.stream()
                    .filter(combined::contains)
                    .findFirst()
                    .ifPresent(keyword -> findings.add(new SuspiciousProcess(
                            processHandle.pid(),
                            extractName(command, commandLine),
                            command,
                            "matched keyword: " + keyword
                    )));
        });

        return findings;
    }

    private String extractName(String command, String commandLine) {
        if (!command.isBlank()) {
            int sep = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\'));
            return sep >= 0 ? command.substring(sep + 1) : command;
        }
        if (!commandLine.isBlank()) {
            String firstToken = commandLine.trim().split("\\s+")[0];
            int sep = Math.max(firstToken.lastIndexOf('/'), firstToken.lastIndexOf('\\'));
            return sep >= 0 ? firstToken.substring(sep + 1) : firstToken;
        }
        return "unknown";
    }
}
