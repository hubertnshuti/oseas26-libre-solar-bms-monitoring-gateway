<?php

declare(strict_types=1);

use App\Models\Company;
use App\Models\CompanyDatabase;
use App\Models\MpmPlugin;
use App\Models\Plugins;
use App\Plugins\LibreSolarBms\Models\Battery;
use App\Services\DatabaseProxyManagerService;
use Illuminate\Contracts\Console\Kernel as ConsoleKernel;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

$backend = getenv('BMS_TEST_BACKEND');
$statePath = getenv('BMS_TEST_STATE');
if (!$backend || !$statePath) {
    throw new RuntimeException('Set BMS_TEST_BACKEND and BMS_TEST_STATE for the recovery check.');
}
chdir($backend);
putenv('APP_ENV=testing');
putenv('CACHE_STORE=array');
putenv('CACHE_DRIVER=array');
putenv('SESSION_DRIVER=array');
require $backend.'/vendor/autoload.php';
$app = require $backend.'/bootstrap/app.php';
$app->loadEnvironmentFrom('.env.testing');
$app->make(ConsoleKernel::class)->bootstrap();
$central = DB::connection('micro_power_manager');
if ($central->getDatabaseName() !== 'mpm_testing'
    || (string) config('database.connections.micro_power_manager.host') !== '127.0.0.1'
    || (int) config('database.connections.micro_power_manager.port') !== 53306) {
    throw new RuntimeException('Recovery checks require mpm_testing on 127.0.0.1:53306. No setup performed.');
}

$mode = PHP_SAPI === 'cli-server' ? 'serve' : ($argv[1] ?? '');
if ($mode === 'setup') {
    if (file_exists($statePath)) {
        throw new RuntimeException('Refusing to replace existing recovery test state.');
    }
    $database = 'LibreSolarBmsRecovery_'.bin2hex(random_bytes(6));
    $central->statement('CREATE DATABASE `'.$database.'`');
    $company = null;
    try {
        foreach (['plugins', 'libre_solar_bms_batteries', 'libre_solar_bms_battery_states', 'libre_solar_bms_receipts', 'libre_solar_bms_events'] as $table) {
            $central->statement('CREATE TABLE `'.$database.'`.`'.$table.'` LIKE `TestCompany_1`.`'.$table.'`');
        }
        app(DatabaseProxyManagerService::class)->buildDatabaseConnectionTestCompany($database);
        $company = Company::create(['name' => 'Battery recovery verification', 'email' => $database.'@example.invalid',
            'address' => 'Isolated testing', 'phone' => '+255000000000', 'country_id' => -1]);
        CompanyDatabase::create(['company_id' => $company->id, 'database_name' => $database]);
        $token = bin2hex(random_bytes(32));
        $company->apiKeys()->create(['name' => 'Recovery verification', 'token_hash' => hash('sha256', $token), 'active' => true]);
        Plugins::create(['mpm_plugin_id' => MpmPlugin::LIBRE_SOLAR_BMS, 'status' => Plugins::ACTIVE]);
        $battery = Battery::create(['node_id' => '53494D0000000001', 'label' => 'Recovery test battery', 'adapter_id' => 'mpm-recovery', 'source' => 'simulator']);
        umask(0077);
        file_put_contents($statePath, json_encode(['database' => $database, 'company' => $company->id, 'battery' => $battery->id, 'token' => $token], JSON_THROW_ON_ERROR));
        echo json_encode(['result' => 'setup', 'isolated' => true], JSON_THROW_ON_ERROR).PHP_EOL;
    } catch (Throwable $error) {
        if ($company !== null) {
            $company->apiKeys()->delete();
            CompanyDatabase::where('company_id', $company->id)->delete();
            $company->delete();
        }
        $central->statement('DROP DATABASE `'.$database.'`');
        throw $error;
    }
    exit;
}

$state = json_decode(file_get_contents($statePath), true, flags: JSON_THROW_ON_ERROR);
if (!preg_match('/^LibreSolarBmsRecovery_[0-9a-f]{12}$/D', $state['database'])
    || CompanyDatabase::where('company_id', $state['company'])->value('database_name') !== $state['database']) {
    throw new RuntimeException('Recovery test ownership check failed.');
}
if ($mode === 'cleanup') {
    $company = Company::findOrFail($state['company']);
    $company->apiKeys()->delete();
    CompanyDatabase::where('company_id', $company->id)->delete();
    $company->delete();
    $central->statement('DROP DATABASE `'.$state['database'].'`');
    unlink($statePath);
    echo json_encode(['result' => 'cleaned_up'], JSON_THROW_ON_ERROR).PHP_EOL;
    exit;
}
app(DatabaseProxyManagerService::class)->buildDatabaseConnectionTestCompany($state['database']);
if ($mode === 'inspect') {
    $connection = DB::connection('tenant');
    $snapshot = $connection->table('libre_solar_bms_battery_states')->where('battery_id', $state['battery'])->first();
    $decode = static fn (?string $value): mixed => $value === null ? null : json_decode($value, true, flags: JSON_THROW_ON_ERROR);
    echo json_encode(['summary' => $decode($snapshot?->summary), 'attributes' => $decode($snapshot?->attributes),
        'status' => $decode($snapshot?->status),
        'events' => $connection->table('libre_solar_bms_events')->where('battery_id', $state['battery'])->get()->map(static fn ($row) => $decode($row->payload))->all(),
        'event_receipts' => $connection->table('libre_solar_bms_receipts')->where('battery_id', $state['battery'])->where('message_id', 'like', '%:events:%')->count()], JSON_THROW_ON_ERROR).PHP_EOL;
    exit;
}
if ($mode !== 'serve') {
    throw new RuntimeException('Unknown recovery test mode.');
}
$kernel = $app->make(HttpKernel::class);
$request = Request::capture();
$response = $kernel->handle($request);
$response->send();
$kernel->terminate($request, $response);
