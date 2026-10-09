import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
test('first-message ledger enforces one active delivery per item and forbids direct client access',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);create table ebay_order_lines(id uuid primary key);create table ebay_seller_accounts(id uuid primary key);create table ebay_conversations(id uuid primary key);`);
 const sql=await readFile(new URL('../../supabase/migrations/20261009004000_order_chat_starts.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const line='11111111-1111-4111-8111-111111111111',seller='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333';
 await db.query('insert into ebay_order_lines values ($1)',[line]);await db.query('insert into ebay_seller_accounts values ($1)',[seller]);await db.query('insert into auth.users values ($1)',[actor]);
 const insert=status=>db.query('insert into ebay_order_chat_starts(id,order_line_id,seller_account_id,buyer_username,body_sha256,message_text,status,created_by) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)',[line,seller,'buyer','hash','Hello',status,actor]);
 await insert('sending');await assert.rejects(insert('sending'),e=>e.code==='23505');await db.exec("update ebay_order_chat_starts set status='unknown'");await assert.rejects(insert('sending'),e=>e.code==='23505');await db.exec("update ebay_order_chat_starts set status='failed'");await insert('sent');await assert.rejects(insert('sending'),e=>e.code==='23505');
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from ebay_order_chat_starts'),e=>e.code==='42501');await assert.rejects(insert('failed'),e=>e.code==='42501');
 }finally{await db.close();}
});
