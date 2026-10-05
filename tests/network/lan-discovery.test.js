'use strict';

/**
 * tests/network/lan-discovery.test.js
 *
 * La caja encuentra a SU PC principal en la red (aunque cambie la IP) y nunca
 * se conecta a la principal de otro negocio.
 */

const { getDiscoveryHosts, pickPrincipal, findPrincipal, scanForPrincipals } = require('../../server/network/lan-discovery');

const PRINCIPAL_A = { host: '192.168.1.40', port: 3399, baseUrl: 'http://192.168.1.40:3399', isMain: true, serverId: 'srv_aaaaaaaaaaaaaaaa', hostname: 'PC-ADMIN', businessName: 'Colmado La Fe' };
const PRINCIPAL_B = { host: '192.168.1.77', port: 3399, baseUrl: 'http://192.168.1.77:3399', isMain: true, serverId: 'srv_bbbbbbbbbbbbbbbb', hostname: 'OTRA-PC', businessName: 'Farmacia Central' };
const TERMINAL = { host: '192.168.1.50', port: 3399, isMain: false, serverId: null, businessName: 'Colmado La Fe' };

describe('getDiscoveryHosts', () => {
  test('recorre el /24 de cada tarjeta privada sin incluir la IP propia', () => {
    const hosts = getDiscoveryHosts(['192.168.100.7']);
    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('192.168.100.1');
    expect(hosts).toContain('192.168.100.254');
    expect(hosts).not.toContain('192.168.100.7');
  });

  test('no asume 192.168.100.x: usa la red real de cada equipo', () => {
    const hosts = getDiscoveryHosts(['10.0.5.20', '172.16.3.9']);
    expect(hosts).toContain('10.0.5.1');
    expect(hosts).toContain('172.16.3.200');
    expect(hosts.some((h) => h.startsWith('192.168.'))).toBe(false);
  });
});

describe('pickPrincipal', () => {
  test('con identificador guardado, solo acepta esa misma principal', () => {
    expect(pickPrincipal([PRINCIPAL_B, PRINCIPAL_A], { serverId: PRINCIPAL_A.serverId })).toBe(PRINCIPAL_A);
    expect(pickPrincipal([PRINCIPAL_B], { serverId: PRINCIPAL_A.serverId })).toBeNull();
  });

  test('nunca elige una caja terminal', () => {
    expect(pickPrincipal([TERMINAL], { businessName: 'Colmado La Fe' })).toBeNull();
  });

  test('sin identificador: solo si hay UNA principal con el mismo nombre de negocio', () => {
    expect(pickPrincipal([PRINCIPAL_A, PRINCIPAL_B], { businessName: 'colmado la fe' })).toBe(PRINCIPAL_A);
    const twin = { ...PRINCIPAL_B, businessName: 'Colmado La Fe' };
    expect(pickPrincipal([PRINCIPAL_A, twin], { businessName: 'Colmado La Fe' })).toBeNull();
    expect(pickPrincipal([PRINCIPAL_A], {})).toBeNull();
  });
});

describe('findPrincipal', () => {
  test('prueba primero el nombre del equipo (DHCP no lo cambia)', async () => {
    const probe = jest.fn(async (host) => (host === 'PC-ADMIN' ? { ...PRINCIPAL_A, host: '192.168.1.99', baseUrl: 'http://192.168.1.99:3399' } : null));
    const scan = jest.fn(async () => []);
    const found = await findPrincipal({ port: 3399, serverId: PRINCIPAL_A.serverId, hostnames: ['PC-ADMIN'], probe, scan });
    expect(found.foundBy).toBe('hostname');
    expect(found.host).toBe('192.168.1.99');
    expect(scan).not.toHaveBeenCalled();
  });

  test('si el nombre no responde, recorre la red y se queda con la suya', async () => {
    const probe = jest.fn(async () => null);
    const scan = jest.fn(async () => [PRINCIPAL_B, { ...PRINCIPAL_A, host: '192.168.1.120', baseUrl: 'http://192.168.1.120:3399' }]);
    const found = await findPrincipal({ port: 3399, serverId: PRINCIPAL_A.serverId, hostnames: ['PC-ADMIN'], probe, scan });
    expect(found.foundBy).toBe('scan');
    expect(found.host).toBe('192.168.1.120');
  });

  test('si su principal no está en la red, no se conecta a otra', async () => {
    const found = await findPrincipal({
      port: 3399,
      serverId: PRINCIPAL_A.serverId,
      probe: async () => null,
      scan: async () => [PRINCIPAL_B],
    });
    expect(found).toBeNull();
  });
});

describe('scanForPrincipals', () => {
  test('devuelve solo principales y sondea todas las direcciones', async () => {
    const answers = { '10.0.0.2': PRINCIPAL_A, '10.0.0.3': TERMINAL };
    const probe = jest.fn(async (host) => answers[host] || null);
    const found = await scanForPrincipals({ port: 3399, hosts: ['10.0.0.2', '10.0.0.3', '10.0.0.4'], probe, concurrency: 2 });
    expect(found).toEqual([PRINCIPAL_A]);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
