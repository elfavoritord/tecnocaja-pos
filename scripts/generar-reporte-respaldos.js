'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', 'runtime-data', 'auditoria-respaldos');
const folder = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse().find((d) => fs.existsSync(path.join(root, d, 'resultado.json')));
const report = JSON.parse(fs.readFileSync(path.join(root, folder, 'resultado.json')));
const out = path.join(root, folder);
const quote = (v) => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
const escape = (v) => String(v ?? '').replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const now = new Date(report.completedAt || Date.now()).getTime();
const rows = report.businesses.map((b) => {
  const files = report.cloudObjects.filter((o) => o.key.startsWith(`backups/${b.id}/`) && o.verified && o.recoverableCore).sort((a,b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  const last = files[0];
  const hours = last?.capturedAt ? Math.round((now - new Date(last.capturedAt).getTime()) / 3600000) : null;
  return { id: b.id, name: b.name, branch: Boolean(b.parentId), status: b.status || 'sin estado', cloudVerified: files.length, latest: last?.capturedAt || '',
    hours, version: last?.version || '', centralLocal: files.filter((f) => f.localPath && fs.existsSync(f.localPath)).length,
    clientLocal: 'SIN ACCESO A LA PC DEL CLIENTE', historicalCandidates: b.historicalCandidates?.length || 0,
    assessment: !last ? 'SIN COPIA BAJO ID ACTUAL' : hours > 48 ? 'COPIA ANTIGUA: REVISAR MOVIMIENTOS POSTERIORES' : last.integral ? 'V3 VERIFICADO; REVISAR AUTOMATIZACION' : 'INTEGRIDAD OK; FORMATO ANTERIOR V2' };
});
const columns = ['id','name','branch','status','cloudVerified','latest','hours','version','centralLocal','clientLocal','historicalCandidates','assessment'];
fs.writeFileSync(path.join(out, 'negocios.csv'), '\ufeff' + [columns.map(quote).join(','), ...rows.map((r) => columns.map((c) => quote(r[c])).join(','))].join('\r\n'));
const withCloud = rows.filter((r) => r.cloudVerified), missing = rows.filter((r) => !r.cloudVerified);
const namedMissing = missing.filter((r) => r.name !== r.id && !r.branch);
const branchesMissing = missing.filter((r) => r.branch);
const unidentified = missing.filter((r) => r.name === r.id);
const unknown = report.cloudObjects.filter((o) => !report.businesses.some((b) => o.key.startsWith(`backups/${b.id}/`)));
const actualRecoveryPath = path.join(root, 'recuperacion-real-aislada.json');
const actualRecovery = fs.existsSync(actualRecoveryPath) ? JSON.parse(fs.readFileSync(actualRecoveryPath)) : {};
const text = `# Verificación real de B2 y copias locales\n\nFecha del corte de auditoría: ${report.completedAt} (UTC).\n\n` +
  `Se revisaron ${rows.length} registros de licencias. Hay ${withCloud.length} con archivos íntegros bajo su ID actual y ${missing.length} sin archivos bajo ese ID: ${namedMissing.length} registros de negocios con nombre, ${branchesMissing.length} sucursales y ${unidentified.length} registros sin nombre comercial. Estos registros pueden contener duplicados; no se fusionaron empresas.\n\n` +
  `Se descargaron y descifraron ${report.cloudObjects.filter((o) => o.verified).length} respaldos reales. Se comprobó SHA-256 del contenido y coincidencia byte a byte con su copia local. Los archivos originales en B2 se conservaron. Hay ${unknown.length} archivos en prefijos históricos sin licencia actual coincidente; se preservaron y no se reasignaron por nombre.\n\n` +
  `La prueba sintética real en B2: subida=${report.roundTrip?.uploaded}, descarga=${report.roundTrip?.downloaded}, restauración aislada=${report.roundTrip?.restoredInMemory}, archivo de prueba eliminado y ausencia comprobada=${report.roundTrip?.cleaned}. No se restauró encima de una base de producción.\n\n` +
  (actualRecovery.restored ? `Además se descargó de B2 la copia real de ${escape(actualRecovery.name)} y se recuperó en una base temporal independiente: ${actualRecovery.tables} tablas, ${actualRecovery.users} usuarios y ${actualRecovery.files} archivos. La base de origen no se modificó. Limpieza de la base temporal=${actualRecovery.cleanedDatabase}; limpieza de archivos temporales=${actualRecovery.cleanedFiles}. Evidencia: recuperacion-real-aislada.json en el directorio de auditoría.\n\n` : '') +
  `Directorio de copias locales centrales: ${report.centralLocalDirectory}. **Una copia descargada en esta PC no demuestra que exista una copia local en la PC de cada cliente.** La comprobación de sus discos y de los respaldos periódicos requiere acceso a esos equipos. Tampoco demuestra que una copia histórica incluya movimientos posteriores a su corte.\n\n` +
  `Se creó una copia adicional V3 del negocio local “mi prueba test”: 160 tablas, con validación local, subida a su ID correcto y descarga de comprobación. La configuración del proyecto tenía un ID anterior; se corrigió solo esa referencia con evidencia de su caché local y registro en Firebase, sin cambiar ninguna licencia remota.\n\n` +
  `Las 35 copias anteriores son V2: su integridad se verificó, pero carecen del catálogo integral V3 de todos los módulos. Hace falta generar copias nuevas en las instalaciones correspondientes. Las credenciales disponibles permiten operar archivos, pero no crear llaves B2 restringidas (falta writeKeys); no se distribuyó la llave global a los clientes. [Permisos B2](https://www.backblaze.com/apidocs/b2-create-key).\n\n` +
  `## Cobertura por registro\n\n| Negocio | ID | B2 verificados | Último corte UTC | Horas | Copias en esta PC | Diagnóstico |\n|---|---|---:|---|---:|---:|---|\n` +
  rows.map((r) => `| ${escape(r.name)}${r.branch ? ' (sucursal)' : ''} | ${escape(r.id)} | ${r.cloudVerified} | ${r.latest || '—'} | ${r.hours ?? '—'} | ${r.centralLocal} | ${r.assessment}${r.historicalCandidates ? `; ${r.historicalCandidates} candidatos históricos requieren validar identidad` : ''} |`).join('\n') +
  `\n\n## Próximos trabajos que necesitan acceso a las instalaciones\n\n1. Verificar los discos de las PC principales y sus carpetas personalizadas de backup.\n2. Crear respaldos nuevos desde cada base real y subirlos bajo su identidad original.\n3. Configurar una llave B2 restringida por negocio, comprobar la cola y el respaldo automático.\n4. Comparar el corte con la última operación y ensayar recuperación aislada de cada versión.\n\nNo se prometió que todos los negocios estén protegidos: los faltantes y las copias antiguas quedan identificados arriba.\n`;
fs.writeFileSync(path.join(out, 'INFORME.md'), text);
console.log(JSON.stringify({ report: path.join(out, 'INFORME.md'), csv: path.join(out, 'negocios.csv'), verifiedFiles: report.cloudObjects.filter((o) => o.verified).length, withCloud: withCloud.length, namedMissing: namedMissing.length, branchesMissing: branchesMissing.length, unidentified: unidentified.length, historicalOrphanFiles: unknown.length }, null, 2));
