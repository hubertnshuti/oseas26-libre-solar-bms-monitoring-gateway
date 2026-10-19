<?php

declare(strict_types=1);

use App\Utils\DemoCompany;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory;

require '/var/www/html/vendor/autoload.php';

function check(bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

try {
    $http = (new Factory())->acceptJson()->timeout(10)->baseUrl('http://127.0.0.1:8000/api');
    $login = $http->post('/auth/login', [
        'email' => DemoCompany::DEMO_COMPANY_ADMIN_EMAIL,
        'password' => DemoCompany::DEMO_COMPANY_PASSWORD,
    ]);
    check($login->status() === 200 && is_string($login->json('access_token')), 'Demo login failed; inspect backend logs and initialization.');
    $http = $http->withToken($login->json('access_token'));
    echo "PASS demo administrator login\n";

    $list = $http->get('/libre-solar-bms/batteries');
    check($list->status() === 200, 'Battery list failed; check plugin access and provisioning.');
    $batteries = $list->json('data');
    check(is_array($batteries) && count($batteries) === 1, 'Expected exactly one provisioned demonstration battery.');
    $battery = $batteries[0];
    check(($battery['source'] ?? null) === 'simulator', 'The demo battery must be explicitly identified as simulated.');
    $path = '/libre-solar-bms/batteries/'.$battery['id'];

    for ($attempt = 0; $attempt < 10; ++$attempt) {
        $response = $http->get($path);
        check($response->status() === 200, 'Battery detail failed; inspect backend logs.');
        $detail = $response->json('data');
        $summary = $detail['summary'] ?? null;
        $attributes = $detail['attributes'] ?? null;
        $status = $detail['status'] ?? null;
        $observedAt = strtotime($detail['metric_observed_at'] ?? '') ?: 0;
        $checkedAt = strtotime($status['status_checked_at'] ?? '') ?: 0;
        $ready = is_array($summary) && is_array($attributes) && is_array($status)
            && ($status['source_status'] ?? null) === 'fresh'
            && ($detail['integration_status'] ?? null) === 'recent'
            && time() - $observedAt <= 120 && $observedAt <= time() + 5
            && time() - $checkedAt < ($detail['integration_stale_after_seconds'] ?? 0)
            && $checkedAt <= time() + 5;
        if ($ready) {
            break;
        }
        if ($attempt < 9) {
            sleep(10);
        }
    }
    check($ready, 'No complete recent delivery within 90 seconds; use normal-cycle and inspect adapter/simulator logs, clocks and queue state.');
    check(($summary['source'] ?? null) === 'simulator' && ($attributes['source'] ?? null) === 'simulator', 'Summary/metadata provenance is inconsistent.');
    check(($summary['node_id'] ?? null) === $battery['node_id'] && ($attributes['node_id'] ?? null) === $battery['node_id'], 'Summary/metadata node binding is inconsistent.');
    check(is_numeric($summary['soc'] ?? null), 'State of charge is missing.');
    check(($attributes['profile_id'] ?? null) === 'demo-lfp-4s-v1' && count($attributes['cell_channels'] ?? []) === 4, 'Four-cell demo source metadata is incomplete.');
    foreach (['soh', 'cycle_count'] as $field) {
        check(array_key_exists($field, $summary) && $summary[$field] === null && ($summary['quality'][$field] ?? null) === 'unsupported', 'Unsupported measurements must remain null with an explicit quality reason.');
    }
    echo "PASS simulated battery, recent summary, recovered metadata and fresh source check\n";
    echo "PASS unsupported state of health/cycle count remain unavailable\n";
    $events = $http->get($path.'/events');
    check($events->status() === 200 && is_array($events->json('data')), 'Battery event history is unavailable.');
    echo "PASS authenticated event history read\n";
    echo "Browser display and Home Assistant onboarding still require the checks in docs/demo.md.\n";
} catch (ConnectionException) {
    fwrite(STDERR, "FAIL backend HTTP connection failed; check docker compose ps and backend logs.\n");
    exit(1);
} catch (RuntimeException $exception) {
    fwrite(STDERR, 'FAIL '.$exception->getMessage()."\n");
    exit(1);
}
