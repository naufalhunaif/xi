import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'account.login': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.index': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'orders.save_routing': { paramsTuple?: []; params?: {} }
    'orders.refresh_groups': { paramsTuple?: []; params?: {} }
    'orders.save': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'orders.retry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'orders.acknowledge': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'orders.history': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'account.logout': { paramsTuple?: []; params?: {} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup': { paramsTuple?: []; params?: {} }
    'carts.index': { paramsTuple?: []; params?: {} }
    'carts.mutate': { paramsTuple: [ParamValue]; params: {'action': ParamValue} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.contact_read': { paramsTuple?: []; params?: {} }
    'dashboard.contact_mode': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.contact_exclusion': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.send_message': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.react_message': { paramsTuple?: []; params?: {} }
    'dashboard.connect': { paramsTuple?: []; params?: {} }
    'dashboard.disconnect': { paramsTuple?: []; params?: {} }
    'dashboard.settings': { paramsTuple?: []; params?: {} }
    'production.index': { paramsTuple?: []; params?: {} }
    'production.save': { paramsTuple?: []; params?: {} }
    'payment_methods.index': { paramsTuple?: []; params?: {} }
    'payments.create': { paramsTuple?: []; params?: {} }
    'payments.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'payment_methods.delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'skill_edits.create': { paramsTuple?: []; params?: {} }
    'skill_edits.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.evaluations': { paramsTuple?: []; params?: {} }
    'learning.index': { paramsTuple?: []; params?: {} }
    'learning.save': { paramsTuple?: []; params?: {} }
    'learning.rollback': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.codex_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_verify': { paramsTuple?: []; params?: {} }
    'dashboard.claude_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_verify': { paramsTuple?: []; params?: {} }
    'dashboard.shared_mcp_callback': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'mcp.callback': { paramsTuple: [ParamValue]; params: {'loginId': ParamValue} }
    'mcp.callback.withId': { paramsTuple: [ParamValue,ParamValue]; params: {'loginId': ParamValue,'callbackId': ParamValue} }
    'dashboard.mcp_create': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_delete': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
  }
  GET: {
    'account.login': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.index': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'orders.history': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'carts.index': { paramsTuple?: []; params?: {} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'production.index': { paramsTuple?: []; params?: {} }
    'payment_methods.index': { paramsTuple?: []; params?: {} }
    'skill_edits.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.evaluations': { paramsTuple?: []; params?: {} }
    'learning.index': { paramsTuple?: []; params?: {} }
    'dashboard.oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.codex_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.shared_mcp_callback': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'mcp.callback': { paramsTuple: [ParamValue]; params: {'loginId': ParamValue} }
    'mcp.callback.withId': { paramsTuple: [ParamValue,ParamValue]; params: {'loginId': ParamValue,'callbackId': ParamValue} }
  }
  HEAD: {
    'account.login': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.index': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'orders.history': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'carts.index': { paramsTuple?: []; params?: {} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'production.index': { paramsTuple?: []; params?: {} }
    'payment_methods.index': { paramsTuple?: []; params?: {} }
    'skill_edits.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.evaluations': { paramsTuple?: []; params?: {} }
    'learning.index': { paramsTuple?: []; params?: {} }
    'dashboard.oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.codex_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.shared_mcp_callback': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'mcp.callback': { paramsTuple: [ParamValue]; params: {'loginId': ParamValue} }
    'mcp.callback.withId': { paramsTuple: [ParamValue,ParamValue]; params: {'loginId': ParamValue,'callbackId': ParamValue} }
  }
  PUT: {
    'orders.save_routing': { paramsTuple?: []; params?: {} }
    'orders.save': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'production.save': { paramsTuple?: []; params?: {} }
    'payments.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'learning.save': { paramsTuple?: []; params?: {} }
  }
  POST: {
    'orders.refresh_groups': { paramsTuple?: []; params?: {} }
    'orders.retry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'orders.acknowledge': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'account.logout': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup': { paramsTuple?: []; params?: {} }
    'carts.mutate': { paramsTuple: [ParamValue]; params: {'action': ParamValue} }
    'dashboard.contact_read': { paramsTuple?: []; params?: {} }
    'dashboard.contact_mode': { paramsTuple?: []; params?: {} }
    'dashboard.contact_exclusion': { paramsTuple?: []; params?: {} }
    'dashboard.send_message': { paramsTuple?: []; params?: {} }
    'dashboard.react_message': { paramsTuple?: []; params?: {} }
    'dashboard.connect': { paramsTuple?: []; params?: {} }
    'dashboard.disconnect': { paramsTuple?: []; params?: {} }
    'dashboard.settings': { paramsTuple?: []; params?: {} }
    'payments.create': { paramsTuple?: []; params?: {} }
    'skill_edits.create': { paramsTuple?: []; params?: {} }
    'learning.rollback': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_verify': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_verify': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_create': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'payment_methods.delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.mcp_delete': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}