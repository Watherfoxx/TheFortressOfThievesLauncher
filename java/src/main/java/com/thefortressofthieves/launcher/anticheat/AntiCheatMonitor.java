package com.thefortressofthieves.launcher.anticheat;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.FileHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/**
 * Coordinates anti-cheat stack scanning and webhook notifications.
 */
public class AntiCheatMonitor {
    private static final String DEFAULT_WEBHOOK_URL = "https://discord.com/api/webhooks/1479979837920645391/gk-m5A21RWsqS5xR4y1DZgJJmrp-X8bKE8u6_Swc8O1ZPhRvq9uuhYvt8mbgxk910qkw";
    private static final int SCAN_INTERVAL_SECONDS = 10;
    private static final long WEBHOOK_RATE_LIMIT_MILLIS = TimeUnit.MINUTES.toMillis(1);

    private final ThreadStackScanner threadStackScanner;
    private final WebhookNotifier webhookNotifier;
    private final ScheduledExecutorService scheduler;
    private final Logger logger;

    private volatile long lastWebhookSentAt;

    public AntiCheatMonitor(
        ThreadStackScanner threadStackScanner,
        WebhookNotifier webhookNotifier,
        ScheduledExecutorService scheduler,
        Logger logger
    ) {
        this.threadStackScanner = threadStackScanner;
        this.webhookNotifier = webhookNotifier;
        this.scheduler = scheduler;
        this.logger = logger;
    }

    /**
     * Starts periodic anti-cheat scanning with default configuration.
     *
     * @return active monitor instance.
     */
    public static AntiCheatMonitor start() {
        Logger logger = createLogger();
        AntiCheatMonitor monitor = new AntiCheatMonitor(
            new ThreadStackScanner(),
            new WebhookNotifier(DEFAULT_WEBHOOK_URL),
            Executors.newSingleThreadScheduledExecutor(),
            logger
        );

        monitor.scheduler.scheduleAtFixedRate(
            monitor::scan,
            0,
            SCAN_INTERVAL_SECONDS,
            TimeUnit.SECONDS
        );

        logger.info("AntiCheatMonitor started with scan interval " + SCAN_INTERVAL_SECONDS + " seconds.");
        return monitor;
    }

    /**
     * Runs one anti-cheat scan cycle.
     */
    public void scan() {
        try {
            logger.info("Anti-cheat scan started.");

            ThreadStackScanner.ScanResult scanResult = threadStackScanner.scan();
            if (!scanResult.detected()) {
                logger.info("No suspicious activity detected.");
                return;
            }

            logger.warning("[ANTI-CHEAT DETECTION]\n\nInjected classes detected.\n\nClasses:\n"
                + String.join("\n", scanResult.suspiciousClasses())
                + "\n\nThreads:\n"
                + scanResult.suspiciousThreads()
                + "\n\nTime:\n"
                + Instant.now());

            scanResult.suspiciousFrames().forEach(frame ->
                logger.warning("Suspicious frame => thread=\"" + frame.threadName()
                    + "\", class=" + frame.className()
                    + ", stack=" + frame.stackLine())
            );

            if (canSendWebhookNow()) {
                int responseCode = webhookNotifier.sendAlert(
                    scanResult.suspiciousClasses(),
                    scanResult.suspiciousThreads()
                );
                lastWebhookSentAt = System.currentTimeMillis();
                logger.info("Webhook response: " + responseCode);
            } else {
                logger.info("Webhook skipped due to rate limit (max once per minute).");
            }
        } catch (Exception ex) {
            logger.log(Level.WARNING, "Anti-cheat scan failed but launcher continues.", ex);
        }
    }

    /**
     * Stops periodic scanning and releases scheduler resources.
     */
    public void stop() {
        try {
            scheduler.shutdownNow();
        } catch (Exception ex) {
            logger.log(Level.WARNING, "Failed to stop anti-cheat scheduler cleanly.", ex);
        }
        logger.info("AntiCheatMonitor stopped.");
    }

    private boolean canSendWebhookNow() {
        long now = System.currentTimeMillis();
        return now - lastWebhookSentAt >= WEBHOOK_RATE_LIMIT_MILLIS;
    }

    private static Logger createLogger() {
        Logger logger = Logger.getLogger(AntiCheatMonitor.class.getName());
        logger.setUseParentHandlers(false);

        try {
            Path logFile = Path.of("anticheat.log");
            FileHandler fileHandler = new FileHandler(logFile.toString(), true);
            fileHandler.setFormatter(new SimpleLineFormatter());
            logger.addHandler(fileHandler);
        } catch (IOException e) {
            logger.log(Level.WARNING, "Failed to initialize anticheat.log file handler.", e);
        }

        return logger;
    }

    private static class SimpleLineFormatter extends Formatter {
        @Override
        public String format(LogRecord record) {
            return "%s [%s] %s%n".formatted(record.getMillis(), record.getLevel(), record.getMessage());
        }
    }
}
