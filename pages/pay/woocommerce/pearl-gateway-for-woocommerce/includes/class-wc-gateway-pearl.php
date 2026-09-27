<?php
/**
 * Pearl (PRL) payment gateway for WooCommerce.
 *
 * How it works:
 *  - Each order is assigned the next fresh Pearl Taproot address from the
 *    merchant's pre-generated address pool (Settings → Pearl). Generate the
 *    pool with any BIP-86 wallet (e.g. the Pearl Pay toolkit page) — keys
 *    never touch WordPress.
 *  - The order total is converted to grains (1 PRL = 100,000,000 grains) at
 *    the configured PRL rate. The thank-you page shows a QR + address and
 *    watches Blockbook live (bundled pearl-pay.js SDK).
 *  - Orders are marked paid ONLY by server-side Blockbook checks (AJAX check
 *    on the thank-you page + a 5-minute cron sweep). The browser UI can never
 *    mark an order paid by itself.
 *
 * @package Pearl_Gateway
 */

defined('ABSPATH') || exit;

class WC_Gateway_Pearl extends WC_Payment_Gateway {

    const GRAIN_PER_PRL = '100000000';

    public function __construct() {
        $this->id                 = 'pearl';
        $this->icon               = '';
        $this->has_fields         = false;
        $this->method_title       = __('Pearl (PRL)', 'pearl-gateway');
        $this->method_description = __('Accept Pearl (PRL) — fresh Taproot address per order, verified against Blockbook.', 'pearl-gateway');
        $this->order_button_text  = __('Pay with Pearl', 'pearl-gateway');

        $this->init_form_fields();
        $this->init_settings();

        $this->title       = $this->get_option('title', $this->method_title);
        $this->description = $this->get_option('description', '');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
        add_action('woocommerce_thankyou_' . $this->id, array($this, 'thankyou_page'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_thankyou_assets'));
    }

    /* ============================== settings ============================== */

    public function init_form_fields() {
        $this->form_fields = array(
            'enabled' => array(
                'title'   => __('Enable/Disable', 'pearl-gateway'),
                'type'    => 'checkbox',
                'label'   => __('Enable Pearl (PRL) payments', 'pearl-gateway'),
                'default' => 'no',
            ),
            'title' => array(
                'title'       => __('Title', 'pearl-gateway'),
                'type'        => 'text',
                'description' => __('Shown to customers at checkout.', 'pearl-gateway'),
                'default'     => __('Pearl (PRL)', 'pearl-gateway'),
            ),
            'description' => array(
                'title'   => __('Description', 'pearl-gateway'),
                'type'    => 'textarea',
                'default' => __('Pay with Pearl (PRL). You will receive a fresh payment address after placing your order.', 'pearl-gateway'),
            ),
            'network' => array(
                'title'   => __('Network', 'pearl-gateway'),
                'type'    => 'select',
                'options' => array(
                    'mainnet' => __('Mainnet (prl1p…)', 'pearl-gateway'),
                    'testnet' => __('Testnet (tprl1p…)', 'pearl-gateway'),
                ),
                'default' => 'mainnet',
            ),
            'address_pool' => array(
                'title'       => __('Address pool', 'pearl-gateway'),
                'type'        => 'textarea',
                'description' => __('One Pearl Taproot receive address per line. Generate them with any BIP-86 wallet (the Pearl Pay toolkit page can do this) and paste them here — each order consumes the next unused address. Add more before the pool runs out. Your seed/private keys NEVER go here.', 'pearl-gateway'),
                'default'     => '',
                'css'         => 'min-height:120px;font-family:monospace;',
            ),
            'blockbook' => array(
                'title'       => __('Blockbook URL', 'pearl-gateway'),
                'type'        => 'text',
                'description' => __('HTTPS endpoint used to watch for payments.', 'pearl-gateway'),
                'default'     => 'https://blockbook.pearlresearch.ai',
            ),
            'req_conf' => array(
                'title'       => __('Required confirmations', 'pearl-gateway'),
                'type'        => 'number',
                'description' => __('Orders are marked paid only after this many confirmations. Use 0 for instant (0-conf) acceptance at your own risk.', 'pearl-gateway'),
                'default'     => '2',
            ),
            'expiry_minutes' => array(
                'title'       => __('Payment window (minutes)', 'pearl-gateway'),
                'type'        => 'number',
                'description' => __('Orders not paid within this window are marked expired by the sweep.', 'pearl-gateway'),
                'default'     => '60',
            ),
            'rate_mode' => array(
                'title'   => __('PRL rate source', 'pearl-gateway'),
                'type'    => 'select',
                'options' => array(
                    'manual' => __('Manual rate (always works)', 'pearl-gateway'),
                    'auto'   => __('CoinGecko (USD stores only), manual fallback', 'pearl-gateway'),
                ),
                'default' => 'manual',
            ),
            'manual_rate' => array(
                'title'       => __('Manual rate: 1 PRL = ? (store currency)', 'pearl-gateway'),
                'type'        => 'text',
                'description' => __('E.g. 1.50 means one PRL is worth 1.50 of your store currency. Used always in manual mode, and as fallback in auto mode.', 'pearl-gateway'),
                'default'     => '',
            ),
            'debug' => array(
                'title'   => __('Debug log', 'pearl-gateway'),
                'type'    => 'checkbox',
                'label'   => __('Log Blockbook checks to the WooCommerce log', 'pearl-gateway'),
                'default' => 'no',
            ),
        );
    }

    /* ============================ admin helpers =========================== */

    /**
     * Parse the address pool into a clean list of valid addresses for the
     * configured network. Format-gate only (full bech32m checksum validation
     * happens where the addresses are generated — the toolkit page).
     *
     * @return string[]
     */
    public function get_pool() {
        $raw  = (string) $this->get_option('address_pool', '');
        $net  = $this->get_option('network', 'mainnet');
        $re   = $net === 'mainnet' ? '/^prl1p[02-9ac-hj-np-z]{58}$/' : '/^(tprl1p|rprl1p)[02-9ac-hj-np-z]{58}$/';
        $out  = array();
        foreach (preg_split('/\r\n|\r|\n/', $raw) as $line) {
            $line = trim($line);
            if ($line !== '' && preg_match($re, $line)) {
                $out[] = $line;
            }
        }
        return array_values(array_unique($out));
    }

    public function pool_remaining() {
        $pool = $this->get_pool();
        $used = get_option('pearl_gateway_used_count', 0);
        return max(0, count($pool) - ((int) $used % max(1, count($pool))));
    }

    public function admin_options() {
        parent::admin_options();
        $pool = $this->get_pool();
        $remaining = $this->pool_remaining();
        if (empty($pool)) {
            echo '<div class="notice notice-error inline"><p><strong>' . esc_html__('Pearl: the address pool is empty — no orders can be paid until you add addresses.', 'pearl-gateway') . '</strong></p></div>';
        } elseif ($remaining < 10) {
            echo '<div class="notice notice-warning inline"><p>' . esc_html(sprintf(
                /* translators: %d: addresses left */
                __('Pearl: only %d unused addresses left in the pool. Add more soon.', 'pearl-gateway'),
                $remaining
            )) . '</p></div>';
        }
    }

    /* ============================ rate handling =========================== */

    /**
     * Store-currency price of 1 PRL as float. Manual setting always wins when
     * present; auto mode tries CoinGecko (USD) with a 10-minute cache.
     *
     * @return float 0 when no usable rate is configured.
     */
    public function get_rate() {
        $manual = (float) $this->get_option('manual_rate', '');
        if ($this->get_option('rate_mode', 'manual') === 'auto' && get_woocommerce_currency() === 'USD') {
            $cached = get_transient('pearl_gateway_rate_usd');
            if ($cached && (float) $cached > 0) {
                return (float) $cached;
            }
            $res = wp_remote_get('https://api.coingecko.com/api/v3/simple/price?ids=pearl-2&vs_currencies=usd', array('timeout' => 10));
            if (!is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200) {
                $j = json_decode(wp_remote_retrieve_body($res), true);
                $usd = isset($j['pearl-2']['usd']) ? (float) $j['pearl-2']['usd'] : 0;
                if ($usd > 0) {
                    set_transient('pearl_gateway_rate_usd', (string) $usd, 10 * MINUTE_IN_SECONDS);
                    return $usd;
                }
            }
        }
        return $manual > 0 ? $manual : 0;
    }

    /**
     * Convert a store-currency amount string to integer grains.
     * Uses bcmath when available to avoid float dust errors.
     */
    public static function amount_to_grains($amount_str, $rate) {
        $amount_str = (string) $amount_str;
        $rate       = (string) $rate;
        if (function_exists('bcmul') && function_exists('bcdiv')) {
            $grains = bcdiv(bcmul($amount_str, self::GRAIN_PER_PRL, 8), $rate, 0);
            return ltrim($grains, '0') === '' ? '0' : ltrim($grains, '0');
        }
        return (string) (int) round(((float) $amount_str / (float) $rate) * 100000000);
    }

    /* ============================ checkout flow =========================== */

    public function process_payment($order_id) {
        $order = wc_get_order($order_id);
        if (!$order) {
            return array('result' => 'failure', 'redirect' => '');
        }

        $rate = $this->get_rate();
        if ($rate <= 0) {
            wc_add_notice(__('Pearl payments are temporarily unavailable (no PRL rate configured).', 'pearl-gateway'), 'error');
            return array('result' => 'failure', 'redirect' => '');
        }

        $pool = $this->get_pool();
        if (empty($pool)) {
            wc_add_notice(__('Pearl payments are temporarily unavailable (address pool empty).', 'pearl-gateway'), 'error');
            return array('result' => 'failure', 'redirect' => '');
        }

        // Assign the next pool address (round-robin; repeats only after the
        // whole pool is consumed — add more addresses before that happens).
        $used    = (int) get_option('pearl_gateway_used_count', 0);
        $address = $pool[$used % count($pool)];
        update_option('pearl_gateway_used_count', $used + 1, false);

        $grains  = self::amount_to_grains($order->get_total(), $rate);
        $expiry  = time() + ((int) $this->get_option('expiry_minutes', 60)) * MINUTE_IN_SECONDS;

        $order->update_meta_data('_pearl_address', $address);
        $order->update_meta_data('_pearl_grains', $grains);
        $order->update_meta_data('_pearl_rate', (string) $rate);
        $order->update_meta_data('_pearl_expires_at', (string) $expiry);
        $order->save_meta_data();

        $order->update_status('on-hold', sprintf(
            /* translators: 1: grains, 2: address */
            __('Awaiting Pearl payment of %1$s grains to %2$s.', 'pearl-gateway'),
            $grains,
            $address
        ));
        wc_reduce_stock_levels($order_id);
        WC()->cart->empty_cart();

        return array(
            'result'   => 'success',
            'redirect' => $this->get_return_url($order),
        );
    }

    /* ============================ thank-you page ========================== */

    public function enqueue_thankyou_assets() {
        if (!is_order_received_page()) {
            return;
        }
        $order_id = absint(get_query_var('order-received'));
        $order    = $order_id ? wc_get_order($order_id) : false;
        if (!$order || $order->get_payment_method() !== $this->id) {
            return;
        }
        wp_enqueue_script('pearl-pay-sdk', PEARL_GATEWAY_URL . 'assets/js/pearl-pay.js', array(), PEARL_GATEWAY_VERSION, true);
        wp_enqueue_script('pearl-thankyou', PEARL_GATEWAY_URL . 'assets/js/pearl-thankyou.js', array('pearl-pay-sdk'), PEARL_GATEWAY_VERSION, true);
        wp_localize_script('pearl-thankyou', 'PearlGateway', array(
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce'   => wp_create_nonce('pearl_gateway_check_' . $order_id),
        ));
    }

    /**
     * Render the payment box on the thank-you page: QR, address, amount,
     * countdown, live states. pearl-thankyou.js drives it with the bundled
     * PearlPay SDK; the server (AJAX/cron) is the authority on order status.
     */
    public function thankyou_page($order_id) {
        $order   = wc_get_order($order_id);
        if (!$order) {
            return;
        }
        $address = (string) $order->get_meta('_pearl_address');
        $grains  = (string) $order->get_meta('_pearl_grains');
        $expires = (int) $order->get_meta('_pearl_expires_at');
        if ($address === '' || $grains === '') {
            return;
        }
        $prl       = number_format(((float) $grains) / 100000000, 8);
        $remaining = max(0, $expires - time());
        ?>
        <div id="pearl-pay-box"
             data-address="<?php echo esc_attr($address); ?>"
             data-grains="<?php echo esc_attr($grains); ?>"
             data-blockbook="<?php echo esc_attr(rtrim((string) $this->get_option('blockbook', ''), '/')); ?>"
             data-req-conf="<?php echo esc_attr((string) $this->get_option('req_conf', '2')); ?>"
             data-expiry-ms="<?php echo esc_attr((string) ($remaining * 1000)); ?>"
             data-order-id="<?php echo esc_attr((string) $order_id); ?>"
             data-order-key="<?php echo esc_attr($order->get_order_key()); ?>"
             style="border:1px solid #ddd;border-radius:12px;padding:1.25rem;margin:1.5rem 0;max-width:560px">
          <h3 style="margin-top:0"><?php echo esc_html__('Pay with Pearl (PRL)', 'pearl-gateway'); ?></h3>
          <p><?php echo esc_html__('Send exactly', 'pearl-gateway'); ?>
             <strong><?php echo esc_html($prl); ?> PRL</strong>
             <?php echo esc_html__('to this address:', 'pearl-gateway'); ?></p>
          <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
            <canvas id="pearl-pay-qr" width="180" height="180" style="border:1px solid #eee;border-radius:8px"></canvas>
            <div style="flex:1;min-width:220px">
              <code id="pearl-pay-addr" style="word-break:break-all;display:block;margin-bottom:.5rem"><?php echo esc_html($address); ?></code>
              <button type="button" id="pearl-pay-copy" class="button"><?php echo esc_html__('Copy address', 'pearl-gateway'); ?></button>
              <p id="pearl-pay-state" style="font-weight:600"><?php echo esc_html__('Awaiting payment…', 'pearl-gateway'); ?></p>
              <p class="description"><?php echo esc_html__('This page watches the blockchain live. Keep it open — your order completes automatically once confirmed.', 'pearl-gateway'); ?></p>
            </div>
          </div>
        </div>
        <?php
    }

    /* ========================= server-side checks ========================= */

    /**
     * Query Blockbook for an address. Returns array with received/confirmed
     * grain strings, or WP_Error.
     */
    public function blockbook_summary($address, $req_conf) {
        $base = rtrim((string) $this->get_option('blockbook', ''), '/');
        if ($base === '') {
            return new WP_Error('no_blockbook', 'Blockbook URL not configured');
        }
        $url = $base . '/api/v2/address/' . rawurlencode($address);
        if ((int) $req_conf > 1) {
            $url .= '?details=txs';
        }
        $res = wp_remote_get($url, array('timeout' => 20));
        if (is_wp_error($res)) {
            return $res;
        }
        if (wp_remote_retrieve_response_code($res) !== 200) {
            return new WP_Error('blockbook_http', 'Blockbook HTTP ' . wp_remote_retrieve_response_code($res));
        }
        $j = json_decode(wp_remote_retrieve_body($res), true);
        if (!is_array($j)) {
            return new WP_Error('blockbook_json', 'Blockbook returned invalid JSON');
        }

        // Mirror the PearlPay SDK's summarizeAddress(): received minus sent,
        // confirmed = received minus unconfirmed balance.
        $received  = $this->bigsub($this->big($j, 'totalReceived'), $this->big($j, 'totalSent'));
        $unconf    = $this->big($j, 'unconfirmedBalance');
        if ($this->bigcmp($unconf, '0') < 0) {
            $unconf = '0';
        }
        $confirmed = $this->bigsub($received, $unconf);

        if ((int) $req_conf > 1 && !empty($j['txs']) && is_array($j['txs'])) {
            $deep = '0';
            foreach ($j['txs'] as $tx) {
                $conf = isset($tx['confirmations']) ? (int) $tx['confirmations'] : 0;
                if ($conf < (int) $req_conf) {
                    continue;
                }
                foreach ((array) ($tx['vout'] ?? array()) as $vout) {
                    $addrs = isset($vout['addresses']) && is_array($vout['addresses'])
                        ? $vout['addresses']
                        : (isset($vout['scriptPubKey']['addresses']) && is_array($vout['scriptPubKey']['addresses']) ? $vout['scriptPubKey']['addresses'] : array());
                    if (in_array($address, $addrs, true)) {
                        $deep = $this->bigadd($deep, (string) ($vout['value'] ?? '0'));
                    }
                }
            }
            $confirmed = $deep;
        } elseif ((int) $req_conf <= 0) {
            $confirmed = $received; // 0-conf acceptance
        }

        return array('received' => $received, 'confirmed' => $confirmed);
    }

    /**
     * The authority for order status. Checks Blockbook server-side; marks the
     * order paid when confirmed grains cover the invoice, or expired past the
     * payment window. Returns a state array for AJAX/cron callers.
     */
    public function server_side_check($order) {
        if (!($order instanceof WC_Order)) {
            return array('state' => 'error', 'message' => 'bad order');
        }
        if ($order->get_payment_method() !== $this->id || !$order->has_status('on-hold')) {
            return array('state' => $order->get_status(), 'message' => 'not actionable');
        }

        $address = (string) $order->get_meta('_pearl_address');
        $grains  = (string) $order->get_meta('_pearl_grains');
        $expires = (int) $order->get_meta('_pearl_expires_at');
        $req     = (int) $this->get_option('req_conf', 2);

        $summary = $this->blockbook_summary($address, $req);
        if (is_wp_error($summary)) {
            $this->log('check failed for order ' . $order->get_id() . ': ' . $summary->get_error_message());
            return array('state' => 'awaiting', 'message' => $summary->get_error_message());
        }

        if ($this->bigcmp($summary['confirmed'], $grains) >= 0) {
            $order->payment_complete();
            // translators: %s: confirmed grains
            $order->add_order_note(sprintf(__('Pearl payment confirmed (%s grains).', 'pearl-gateway'), $summary['confirmed']));
            return array('state' => 'confirmed', 'confirmed_grains' => $summary['confirmed'], 'required_grains' => $grains);
        }

        if ($expires > 0 && time() > $expires && $this->bigcmp($summary['received'], '0') <= 0) {
            $order->update_status('cancelled', __('Pearl payment window expired with no funds received.', 'pearl-gateway'));
            return array('state' => 'expired');
        }

        $state = $this->bigcmp($summary['received'], '0') > 0 ? 'detected' : 'awaiting';
        return array(
            'state'            => $state,
            'received_grains'  => $summary['received'],
            'confirmed_grains' => $summary['confirmed'],
            'required_grains'  => $grains,
        );
    }

    /* ============================== utilities ============================= */

    private function big($arr, $key) {
        $v = isset($arr[$key]) ? (string) $arr[$key] : '0';
        if (!preg_match('/^-?[0-9]+$/', $v)) {
            return '0';
        }
        $neg = ($v[0] === '-');
        $v   = ltrim($neg ? substr($v, 1) : $v, '0');
        if ($v === '') {
            $v = '0';
        }
        return ($neg && $v !== '0') ? '-' . $v : $v;
    }

    private function bigadd($a, $b) {
        if (function_exists('bcadd')) {
            return bcadd($a, $b, 0);
        }
        return (string) ((int) $a + (int) $b);
    }

    private function bigsub($a, $b) {
        if (function_exists('bcsub')) {
            $r = bcsub($a, $b, 0);
            return bccomp($r, '0') < 0 ? '0' : $r;
        }
        $r = (int) $a - (int) $b;
        return (string) max(0, $r);
    }

    private function bigcmp($a, $b) {
        if (function_exists('bccomp')) {
            return bccomp($a, $b, 0);
        }
        return ((int) $a) <=> ((int) $b);
    }

    private function log($msg) {
        if ($this->get_option('debug', 'no') !== 'yes') {
            return;
        }
        if (function_exists('wc_get_logger')) {
            wc_get_logger()->info($msg, array('source' => 'pearl-gateway'));
        }
    }
}
