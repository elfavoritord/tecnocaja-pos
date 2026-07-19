# TECNO CAJA PLATFORM — Visión / Prompt Maestro

> Documento de visión a largo plazo, guardado tal cual lo definió Emilio el 2026-07-16.
> No es un plan de implementación inmediata — es la brújula estratégica para decisiones de arquitectura futuras.
> El trabajo actual del proyecto sigue las fases descritas en `CLAUDE.md` (Fase 1 — Modularización del monolito). Este documento describe el destino final, no el siguiente sprint.

## Objetivo

Crear una plataforma empresarial completa donde todos los módulos trabajen de forma integrada, pero cada empresa pueda activar únicamente los módulos que necesite.

La plataforma debe permitir que un cliente pueda iniciar usando solo un módulo (por ejemplo Contabilidad o Facturación Electrónica) y, cuando lo desee, agregar nuevos módulos sin migrar información ni cambiar de sistema.

## Arquitectura General

La plataforma estará compuesta por:

* Tecno Caja POS (Electron)
* Tecno Caja Cloud
* Portal del Contador
* Portal del Empresario
* Portal del Distribuidor
* Aplicación móvil
* Inteligencia Artificial
* API Central
* MariaDB como base de datos principal

Todos los módulos compartirán la misma base de datos y la misma estructura empresarial.

## Filosofía

No quiero construir varios sistemas separados.

Quiero construir una sola plataforma donde cada usuario vea únicamente los módulos que tiene contratados y los permisos que le correspondan.

Todo debe estar conectado.

## Módulos

### Punto de Venta (POS)

* Ventas
* Cotizaciones
* Facturación
* Caja
* Inventario
* Compras
* Clientes
* Suplidores
* NCF
* Facturación Electrónica
* Impresión térmica
* Múltiples cajas
* Múltiples sucursales
* Funcionar sin Internet
* Sincronización automática

### Inventario

* Productos
* Categorías
* Marcas
* Almacenes
* Kardex
* Ajustes
* Transferencias
* Costos
* Productos agotados
* Lotes
* Vencimientos

### Compras

* Órdenes de compra
* Recepciones
* Devoluciones
* Suplidores

### Ventas

* Cotizaciones
* Pedidos
* Facturas
* Devoluciones
* Historial

### Caja

* Apertura
* Cierre
* Arqueo
* Movimientos                 

### Bancos

* Cuentas
* Transferencias
* Conciliaciones

### Finanzas

* Gastos
* Ingresos
* Cuentas por cobrar
* Cuentas por pagar
* Flujo de efectivo

### Contabilidad

* Plan de cuentas
* Asientos contables
* Diario General
* Mayor General
* Balance de Comprobación
* Balance General
* Estado de Resultados
* Flujo de Efectivo

### Nómina

* Empleados
* Nómina
* Vacaciones
* Licencias
* Prestaciones
* Deducciones

### DGII

* 606
* 607
* 608
* 609
* IT-1
* IR-17
* Facturación Electrónica
* NCF
* e-CF
* Exportaciones oficiales

### CRM

* Clientes
* Seguimientos
* Tareas
* Agenda
* Recordatorios

### Recursos Humanos

* Empleados
* Asistencia
* Horarios
* Permisos

### Reportes

* Dashboard
* Ventas
* Compras
* Inventario
* Ganancias
* Gastos
* Contabilidad
* DGII
* Nómina

### Portal del Empresario

Cada empresario podrá:

* Ver todas sus empresas.
* Ver ventas en tiempo real.
* Ver inventario.
* Ver caja.
* Ver ganancias.
* Ver reportes.
* Configurar usuarios.
* Administrar licencias.

### Portal del Contador

Cada contador podrá administrar múltiples empresas desde un solo panel.

Funciones:

* Empresas
* Estados financieros
* Balance General
* Estado de Resultados
* Diario General
* Mayor General
* 606
* 607
* 608
* 609
* IT-1
* Conciliaciones
* Reportes
* Exportar Excel
* Exportar PDF
* Alertas de vencimientos

### Portal del Distribuidor

Los distribuidores podrán:

* Registrar empresas
* Activar licencias
* Administrar clientes
* Ver renovaciones
* Dar soporte
* Ver comisiones

### Super Administrador

Control total del sistema.

* Empresas
* Usuarios
* Licencias
* Planes
* Facturación
* Soporte
* Distribuidores
* Contadores
* Estadísticas generales

## Sistema Modular

Cada empresa podrá activar únicamente los módulos que necesite.

Ejemplos:

Empresa A

* Solo POS

Empresa B

* Solo Contabilidad

Empresa C

* Solo Facturación Electrónica

Empresa D

* POS + Contabilidad

Empresa E

* Nómina + Contabilidad

Todos compartirán la misma plataforma.

## Permisos

Cada usuario tendrá un rol.

* Super Administrador
* Distribuidor
* Contador
* Empresario
* Gerente
* Cajero
* Supervisor
* Almacén
* Compras
* Recursos Humanos

Cada rol tendrá permisos completamente configurables.

## Inteligencia Artificial

Integrar IA para:

* Analizar ventas.
* Detectar pérdidas.
* Recomendar compras.
* Detectar productos lentos.
* Analizar ganancias.
* Responder preguntas sobre el negocio.
* Generar reportes automáticamente.

## Aplicación móvil

El dueño podrá:

* Ver ventas.
* Inventario.
* Caja.
* Reportes.
* Alertas.
* Notificaciones.
* Indicadores del negocio.

## Sincronización

El POS en Electron seguirá funcionando sin Internet.

Cuando exista conexión:

* Sincronizará automáticamente con la plataforma.

Toda la información deberá mantenerse consistente.

## Base de datos

MariaDB será la base de datos principal.

Toda la plataforma deberá compartir la misma estructura de datos para evitar duplicidad.

## Escalabilidad

La plataforma deberá diseñarse para soportar:

* Miles de empresas.
* Miles de usuarios.
* Múltiples sucursales.
* Múltiples cajas.
* Múltiples distribuidores.
* Múltiples contadores.

Todo deberá estar preparado para una futura versión completamente en la nube sin tener que reconstruir el sistema.

---

# Identidad Digital y Ecosistema de Usuarios

## Objetivo

Toda persona que utilice Tecno Caja Platform deberá tener una única identidad digital, independientemente de si usa el POS, la plataforma web, la aplicación móvil o cualquier otro módulo.

## Inicio de sesión

La plataforma deberá permitir iniciar sesión mediante:

* Correo electrónico y contraseña.
* Cuenta de Google.
* Cuenta creada automáticamente durante la instalación de Tecno Caja POS.
* En el futuro, otros proveedores como Microsoft o Apple.

Todas las opciones deberán conducir a la misma cuenta del usuario.

## Cuenta única

Cada usuario tendrá una sola cuenta.

Con esa cuenta podrá acceder a:

* Tecno Caja POS.
* Tecno Caja Cloud.
* Portal del Contador.
* Portal del Empresario.
* Portal del Distribuidor.
* Aplicación móvil.

No deberá crear una cuenta diferente para cada módulo.

## Identificación del usuario

Cuando un usuario inicie sesión, el sistema deberá identificar automáticamente su perfil.

Ejemplos:

* Empresario.
* Contador.
* Distribuidor.
* Super Administrador.
* Cajero.
* Gerente.
* Supervisor.
* Almacén.
* Compras.

Según el perfil, la plataforma mostrará únicamente los módulos autorizados.

## Registro inteligente

Si el usuario nunca ha utilizado Tecno Caja Platform, el sistema deberá iniciar un asistente de registro.

El asistente preguntará:

* ¿Qué tipo de usuario eres?

  * Empresario.
  * Contador.
  * Distribuidor.
  * Otro.

Luego preguntará:

* ¿Qué deseas utilizar?

Opciones:

* Solo POS.
* Solo Contabilidad.
* Solo Facturación Electrónica.
* Solo Nómina.
* Solo Portal del Contador.
* Plataforma completa.

Con esta información, el sistema configurará automáticamente la empresa y los módulos iniciales.

## Usuarios existentes

Si el usuario ya posee una cuenta, el sistema deberá reconocerla automáticamente.

Si ese usuario ya tiene empresas registradas, deberá mostrarlas inmediatamente después del inicio de sesión.

No deberá volver a registrarse.

## Integración con Tecno Caja POS

Cuando un cliente instale Tecno Caja POS, el instalador creará una cuenta principal.

Esa misma cuenta servirá para acceder a:

* Plataforma web.
* Aplicación móvil.
* Portal empresarial.

No será necesario crear otra cuenta.

## Sincronización automática

Si un cliente comenzó utilizando únicamente la plataforma web y posteriormente instala Tecno Caja POS:

* El POS deberá vincularse a su cuenta existente.
* Toda la información deberá sincronizarse automáticamente.

Si el cliente comenzó usando Tecno Caja POS y luego entra a Tecno Caja Cloud:

* La plataforma deberá reconocer su empresa.
* Mostrar todos sus datos.
* Mostrar ventas.
* Inventario.
* Clientes.
* Compras.
* Reportes.
* Configuración.

No deberá importar información manualmente.

## Cotizaciones

El módulo de cotizaciones deberá estar completamente integrado.

Flujo:

Cotización → Aprobación → Pedido → Factura → Venta → Cobro → Contabilidad.

Una cotización aprobada podrá convertirse en venta con un solo clic.

Toda la información deberá conservarse automáticamente.

## Escalabilidad

En el futuro, cualquier módulo nuevo deberá utilizar el mismo sistema de autenticación y la misma identidad digital del usuario.

La plataforma deberá crecer sin obligar a los clientes a crear nuevas cuentas ni duplicar información.

## Principio fundamental

**Un usuario, una cuenta, una empresa y una sola plataforma.**

Todos los módulos deberán compartir la misma identidad, la misma información y la misma base de datos, garantizando una experiencia unificada para empresarios, contadores, distribuidores y administradores.

## Objetivo Final

Construir la plataforma empresarial más completa de República Dominicana, donde cualquier empresa pueda administrar todo su negocio desde un solo lugar, activando únicamente los módulos que necesite, manteniendo una integración total entre el POS, la contabilidad, la DGII, la nómina, los reportes y todos los demás módulos.
