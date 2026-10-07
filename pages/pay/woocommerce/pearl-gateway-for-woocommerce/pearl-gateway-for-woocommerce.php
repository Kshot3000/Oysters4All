<?php
/**
 * Plugin Name:       Pearl Gateway for WooCommerce
 * Plugin URI:        https://kshot3000.github.io/Oysters4All/pages/pay/
 * Description:       Accept Pearl (PRL) payments in WooCommerce. Each order gets a fresh BIP-86 Taproot address from your pre-generated pool; payments are verified live against Blockbook before orders are marked paid. No custody, no server, keys never touch WordPress.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Kshot3000
 * Author URI:        https://x.com/kshot9000
 * License:           GPL-3.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-3.0.html
 * Text Domain:       pearl-gateway
 * Domain Path:       /languages
 * WC requires at least: 7.0
 * WC tested up to:   9.0
 */

defined('ABSPATH') || exit;

define('PEARL_GATEWAY_VERSION', '1.0.0');
define('PEARL_GATEWAY_PATH', plugin_dir_path(__FILE__));
define('PEARL_GATEWAY_URL', plugin_dir_url(__FILE__));

/**
 * Bootstrap after all plugins load so we can check for WooCommerce.
 */
add_action('plugins_loaded', 'pearl_gateway_init', 11);

function pearl_gateway_init() {
    if (!class_exists('WooCommerce')) {
        add_action('admin_notices', 'pearl_gateway_missing_wc_notice');
        return;
    }

    load_plugin_textdomain('pearl-gateway', false, dirname(plugin_basename(__FILE__)) . '/languages');

    require_once PEARL_GATEWAY_PATH . 'includes/class-wc-gateway-pearl.php';

    // Register the gateway with WooCommerce.
    add_filter('woocommerce_payment_gateways', 'pearl_gateway_add_gateway');

    // Cron: sweep on-hold Pearl orders for late confirmations.
    add_action('pearl_gateway_cron_check', 'pearl_gateway_cron_check');
    if (!wp_next_scheduled('pearl_gateway_cron_check')) {
        wp_schedule_event(time(), 'five_minutes', 'pearl_gateway_cron_check');
    }

    // AJAX: browser asks the server for the authoritative payment state
    // (server re-checks Blockbook itself; the order key authenticates).
    add_action('wp_ajax_pearl_gateway_check', 'pearl_gateway_ajax_check');
    add_action('wp_ajax_nopriv_pearl_gateway_check', 'pearl_gateway_ajax_check');
}

function pearl_gateway_add_gateway($gateways) {
    $gateways[] = 'WC_Gateway_Pearl';
    return $gateways;
}

function pearl_gateway_missing_wc_notice() {
    echo '<div class="notice notice-error"><p>';
    echo esc_html__('Pearl Gateway for WooCommerce requires WooCommerce to be installed and active.', 'pearl-gateway');
    echo '</p></div>';
}

/**
 * Add a 5-minute cron schedule.
 */
add_filter('cron_schedules', 'pearl_gateway_cron_schedules');
function pearl_gateway_cron_schedules($schedules) {
    if (!isset($schedules['five_minutes'])) {
        $schedules['five_minutes'] = array(
            'interval' => 5 * MINUTE_IN_SECONDS,
            'display'  => __('Every five minutes', 'pearl-gateway'),
        );
    }
    return $schedules;
}

/**
 * Server-side sweep: for every on-hold order paid with Pearl, re-check
 * Blockbook and complete or expire the order. This is the authority for
 * order status — the browser UI is convenience only.
 */
function pearl_gateway_cron_check() {
    $orders = wc_get_orders(array(
        'status'         => 'on-hold',
        'payment_method' => 'pearl',
        'limit'          => 50,
    ));
    foreach ($orders as $order) {
        /** @var WC_Gateway_Pearl $gw */
        $gateways = WC()->payment_gateways()->payment_gateways();
        if (empty($gateways['pearl'])) {
            return;
        }
        $gateways['pearl']->server_side_check($order);
    }
}

/**
 * AJAX handler: ?action=pearl_gateway_check&order_id=..&key=..&nonce=..
 * Verifies the WooCommerce order key, then runs the same server-side check
 * as the cron. Returns JSON { state, confirmed_grains, required_grains }.
 */
function pearl_gateway_ajax_check() {
    // Note: the WooCommerce order key (a 22-char secret in the thank-you URL)
    // is the auth token here, plus a per-order nonce.
    $order_id = isset($_GET['order_id']) ? absint($_GET['order_id']) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    $key      = isset($_GET['key']) ? sanitize_text_field(wp_unslash($_GET['key'])) : '';
    $nonce    = isset($_GET['nonce']) ? sanitize_text_field(wp_unslash($_GET['nonce'])) : '';

    if (!$order_id || !wp_verify_nonce($nonce, 'pearl_gateway_check_' . $order_id)) {
        wp_send_json_error(array('message' => 'bad nonce'), 403);
    }
    $order = wc_get_order($order_id);
    if (!$order || $order->get_payment_method() !== 'pearl' || !hash_equals((string) $order->get_order_key(), $key)) {
        wp_send_json_error(array('message' => 'bad order'), 403);
    }

    $gateways = WC()->payment_gateways()->payment_gateways();
    /** @var WC_Gateway_Pearl $gw */
    $gw = isset($gateways['pearl']) ? $gateways['pearl'] : null;
    if (!$gw) {
        wp_send_json_error(array('message' => 'gateway unavailable'), 503);
    }
    $result = $gw->server_side_check($order);
    wp_send_json_success($result);
}

/**
 * Clean up the cron job on deactivation (options are kept; uninstall.php
 * removes them when the plugin is deleted).
 */
register_deactivation_hook(__FILE__, 'pearl_gateway_deactivate');
function pearl_gateway_deactivate() {
    $ts = wp_next_scheduled('pearl_gateway_cron_check');
    if ($ts) {
        wp_unschedule_event($ts, 'pearl_gateway_cron_check');
    }
}
