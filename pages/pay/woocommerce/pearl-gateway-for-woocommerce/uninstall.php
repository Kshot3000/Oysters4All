<?php
/**
 * Clean up on plugin deletion (not on deactivation).
 */
defined('WP_UNINSTALL_PLUGIN') || exit;

delete_option('woocommerce_pearl_settings');
delete_option('pearl_gateway_used_count');
delete_transient('pearl_gateway_rate_usd');

$ts = wp_next_scheduled('pearl_gateway_cron_check');
if ($ts) {
    wp_unschedule_event($ts, 'pearl_gateway_cron_check');
}
