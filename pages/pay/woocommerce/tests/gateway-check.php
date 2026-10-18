<?php
// Regression checks for the WooCommerce gateway (Pearl Pay).
// Covers two server-side payment-integrity classes:
//  (1) address-pool reuse — payment checks credit an order from its
//      address's lifetime Blockbook totals, so an address must serve
//      exactly one order (checkout refuses when the pool is exhausted);
//  (2) confirmation depth — Blockbook's tx list is `transactions`
//      (`txs` is an integer count); req_conf must be enforced against it.
// Stubs the WordPress/WooCommerce surface the gateway class touches, loads
// the REAL class file, and drives the real process_payment() +
// server_side_check() code paths.
//
// Exploit scenario (pool of ONE address):
//   1. Order 1 checks out, is assigned the only pool address, and pays it
//      (Blockbook then reports the address's lifetime totals as paid).
//   2. Order 2 checks out. PRISTINE: the round-robin index wraps
//      ($pool[$used % count]) and order 2 is assigned the SAME address;
//      server_side_check then credits order 2 from the address's lifetime
//      confirmed total — order 2 is marked paid with NO new payment.
//      FIXED: order 2's checkout is refused (pool exhausted, no reuse).
//
// Usage: php gateway-check.php [path/to/class-wc-gateway-pearl.php]
// (defaults to the bundled gateway class). Exits 1 on any failure.
error_reporting(E_ALL & ~E_DEPRECATED);
define('ABSPATH', '/tmp/');
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['wp_options'] = array();
$GLOBALS['notices'] = array();
$GLOBALS['orders'] = array();
$GLOBALS['blockbook_body'] = '';

function __($s, $d = null) { return $s; }
function add_action() {}
function add_filter() {}
function get_option($k, $default = false) {
    return array_key_exists($k, $GLOBALS['wp_options']) ? $GLOBALS['wp_options'][$k] : $default;
}
function update_option($k, $v, $autoload = null) { $GLOBALS['wp_options'][$k] = $v; return true; }
function get_transient($k) { return false; }
function set_transient($k, $v, $ttl) { return true; }
function get_woocommerce_currency() { return 'USD'; }
function wc_add_notice($msg, $type = 'success') { $GLOBALS['notices'][] = array($type, $msg); }
function wc_reduce_stock_levels($id) {}
function wc_get_order($id) { return isset($GLOBALS['orders'][$id]) ? $GLOBALS['orders'][$id] : false; }
function wp_remote_get($url, $args = array()) { return array('url' => $url); }
function wp_remote_retrieve_response_code($res) { return 200; }
function wp_remote_retrieve_body($res) { return $GLOBALS['blockbook_body']; }
function is_wp_error($t) { return $t instanceof WP_Error; }
class WP_Error {
    private $msg;
    public function __construct($code = '', $msg = '') { $this->msg = $msg; }
    public function get_error_message() { return $this->msg; }
}
function WC() {
    return new class {
        public $cart;
        public function __construct() {
            $this->cart = new class { public function empty_cart() {} };
        }
    };
}

class WC_Payment_Gateway {
    public $settings = array();
    public function init_form_fields() {}
    public function init_settings() { $this->settings = $GLOBALS['gw_settings']; }
    public function get_option($k, $default = false) {
        return isset($this->settings[$k]) && $this->settings[$k] !== '' ? $this->settings[$k] : $default;
    }
    public function get_return_url($order) { return 'https://shop.example/thankyou'; }
}

class WC_Order {
    private $id; private $meta = array(); private $status = 'pending'; private $total;
    public $paid = false;
    public function __construct($id, $total) { $this->id = $id; $this->total = $total; }
    public function get_id() { return $this->id; }
    public function get_total() { return $this->total; }
    public function get_payment_method() { return 'pearl'; }
    public function get_status() { return $this->status; }
    public function has_status($s) { return $this->status === $s; }
    public function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    public function get_meta($k) { return isset($this->meta[$k]) ? $this->meta[$k] : ''; }
    public function save_meta_data() {}
    public function update_status($s, $note = '') { $this->status = $s; }
    public function payment_complete() { $this->paid = true; $this->status = 'processing'; }
    public function add_order_note($n) {}
}

$classFile = isset($argv[1]) ? $argv[1] : __DIR__ . '/../pearl-gateway-for-woocommerce/includes/class-wc-gateway-pearl.php';
require $classFile;

$ADDR = 'prl1p' . str_repeat('q', 58); // matches the gateway's pool format gate
$GLOBALS['gw_settings'] = array(
    'enabled' => 'yes', 'title' => 'Pearl (PRL)', 'description' => '',
    'network' => 'mainnet', 'address_pool' => $ADDR,
    'blockbook' => 'https://blockbook.example', 'req_conf' => '0',
    'expiry_minutes' => '60', 'rate_mode' => 'manual', 'manual_rate' => '1',
    'debug' => 'no',
);
$gw = new WC_Gateway_Pearl();

$fail = 0;
function check($name, $cond) {
    global $fail;
    echo ($cond ? "ok   " : "FAIL ") . $name . "\n";
    if (!$cond) $fail++;
}

// Order 1: normal checkout + payment.
$o1 = new WC_Order(1, '2'); // 2 currency units at rate 1 => 200000000 grains
$GLOBALS['orders'][1] = $o1;
$r1 = $gw->process_payment(1);
check('order1 checkout succeeds', ($r1['result'] ?? '') === 'success');
check('order1 assigned the pool address', $o1->get_meta('_pearl_address') === $ADDR);

// The customer pays order 1: Blockbook now reports the address lifetime
// totals as fully paid (req_conf=0 path: confirmed = received).
$GLOBALS['blockbook_body'] = json_encode(array(
    'balance' => '200000000', 'totalReceived' => '200000000',
    'totalSent' => '0', 'unconfirmedBalance' => '0',
));
$s1 = $gw->server_side_check($o1);
check('order1 marked paid after its real payment', $o1->paid === true && ($s1['state'] ?? '') === 'confirmed');

// Order 2: a NEW order for the same amount. No new payment is made.
$o2 = new WC_Order(2, '2');
$GLOBALS['orders'][2] = $o2;
$r2 = $gw->process_payment(2);
check('order2 checkout REFUSED when the pool is exhausted (no address reuse)',
      ($r2['result'] ?? '') === 'failure');
check('order2 assigned no address', $o2->get_meta('_pearl_address') === '');
if (($r2['result'] ?? '') === 'success') {
    // Pristine path: prove the free order actually completes.
    $s2 = $gw->server_side_check($o2);
    check('order2 NOT marked paid without a new payment',
          $o2->paid === false);
    echo "  [exploit detail] order2 address=" . $o2->get_meta('_pearl_address') .
         " state=" . ($s2['state'] ?? '?') . " paid=" . var_export($o2->paid, true) . "\n";
}

// ---- Scenario C: confirmation depth must actually be enforced ----------
// Fresh gateway with req_conf=2 (the plugin's recommended/default setting)
// and a 2-address pool so this scenario is independent of the wrap bug.
// Blockbook's REAL response shape (fleet fix 2e5558c, 2026-10-16): the tx
// list is `transactions`; `txs` is an INTEGER count. A payment with only
// 1 confirmation is not in unconfirmedBalance, so the totals fallback
// (received - unconfirmed) counts it as fully confirmed.
$GLOBALS['gw_settings']['req_conf'] = '2';
$GLOBALS['gw_settings']['address_pool'] = $ADDR . "\n" . 'prl1p' . str_repeat('z', 58);
$GLOBALS['wp_options']['pearl_gateway_used_count'] = 0;
$gw2 = new WC_Gateway_Pearl();
$o3 = new WC_Order(3, '2');
$GLOBALS['orders'][3] = $o3;
$r3 = $gw2->process_payment(3);
check('order3 checkout succeeds (depth scenario)', ($r3['result'] ?? '') === 'success');
$payTx = function ($conf) use ($ADDR) {
    return json_encode(array(
        'balance' => '200000000', 'totalReceived' => '200000000',
        'totalSent' => '0', 'unconfirmedBalance' => '0',
        'txs' => 1, // integer COUNT, as real Blockbook returns
        'transactions' => array(array(
            'confirmations' => $conf,
            'vout' => array(array('value' => '200000000', 'addresses' => array($ADDR))),
        )),
    ));
};
$GLOBALS['blockbook_body'] = $payTx(1);
$s3 = $gw2->server_side_check($o3);
check('order3 NOT paid at 1 confirmation when req_conf=2', $o3->paid === false);
echo "  [depth detail] 1-conf state=" . ($s3['state'] ?? '?') . " paid=" . var_export($o3->paid, true) . "\n";
$GLOBALS['blockbook_body'] = $payTx(2);
$gw2->server_side_check($o3);
check('order3 paid at 2 confirmations when req_conf=2 (control)', $o3->paid === true);

// Fallback shape: a non-Blockbook backend that returns the list under
// `txs` as an array must still work (the JS fleet fallback shape).
$o4 = new WC_Order(4, '2');
$GLOBALS['orders'][4] = $o4;
$gw2->process_payment(4); // second pool address
$GLOBALS['blockbook_body'] = json_encode(array(
    'balance' => '200000000', 'totalReceived' => '200000000',
    'totalSent' => '0', 'unconfirmedBalance' => '0',
    'txs' => array(array(
        'confirmations' => 5,
        'vout' => array(array('value' => '200000000', 'addresses' => array('prl1p' . str_repeat('z', 58)))),
    )),
));
$gw2->server_side_check($o4);
check('order4 paid via array-txs fallback shape (control)', $o4->paid === true);

// pool_remaining must tell the truth at/past exhaustion.
$GLOBALS['wp_options']['pearl_gateway_used_count'] = 1;
check('pool_remaining is 0 with 1 used of 1', $gw->pool_remaining() === 0);
$GLOBALS['wp_options']['pearl_gateway_used_count'] = 2;
check('pool_remaining is 0 with 2 used of 1 (past the end)', $gw->pool_remaining() === 0);
$GLOBALS['wp_options']['pearl_gateway_used_count'] = 0;
check('pool_remaining is 1 with 0 used of 1', $gw->pool_remaining() === 1);

echo $fail === 0 ? "ALL PASS\n" : "$fail FAILING\n";
exit($fail === 0 ? 0 : 1);
