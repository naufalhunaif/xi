import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'account.login': { paramsTuple?: []; params?: {} }
    'instagram.verify': { paramsTuple?: []; params?: {} }
    'instagram.receive': { paramsTuple?: []; params?: {} }
    'instagram_content.media': { paramsTuple: [ParamValue]; params: {'name': ParamValue} }
    'account.login_post': { paramsTuple?: []; params?: {} }
    'account.setup': { paramsTuple?: []; params?: {} }
    'account.setup_post': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'beta3': { paramsTuple?: []; params?: {} }
    'beta_3.catalog': { paramsTuple?: []; params?: {} }
    'beta_3.import_catalog': { paramsTuple?: []; params?: {} }
    'beta_3.sync_catalog': { paramsTuple?: []; params?: {} }
    'beta_3.examples': { paramsTuple?: []; params?: {} }
    'beta_3.add_example': { paramsTuple?: []; params?: {} }
    'beta_3.remove_example': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.orders': { paramsTuple?: []; params?: {} }
    'beta_3.approve_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.paid_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.settle_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.paid_amount': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.ready_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.delivered_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.cancel_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.resend_group': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.mcp': { paramsTuple?: []; params?: {} }
    'beta_3.save_mcp': { paramsTuple?: []; params?: {} }
    'beta_3.room': { paramsTuple?: []; params?: {} }
    'beta_3.save_spec': { paramsTuple?: []; params?: {} }
    'beta_3.skill': { paramsTuple?: []; params?: {} }
    'beta_3.update_skill': { paramsTuple?: []; params?: {} }
    'beta_3.recap_status': { paramsTuple?: []; params?: {} }
    'beta_3.start_recap': { paramsTuple?: []; params?: {} }
    'beta_3.weights': { paramsTuple?: []; params?: {} }
    'beta_3.save_weights': { paramsTuple?: []; params?: {} }
    'beta_3.policy': { paramsTuple?: []; params?: {} }
    'beta_3.jev': { paramsTuple?: []; params?: {} }
    'beta_3.save_jev': { paramsTuple?: []; params?: {} }
    'beta_3.test_jev': { paramsTuple?: []; params?: {} }
    'beta_3.jev_decisions': { paramsTuple?: []; params?: {} }
    'beta_3.mark_jev_decision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.save_policy': { paramsTuple?: []; params?: {} }
    'beta_3.rules': { paramsTuple?: []; params?: {} }
    'beta_3.add_rule': { paramsTuple?: []; params?: {} }
    'beta_3.remove_rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.correction': { paramsTuple?: []; params?: {} }
    'beta_3.tests': { paramsTuple?: []; params?: {} }
    'beta_3.run_tests': { paramsTuple?: []; params?: {} }
    'beta_3.remove_test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.customer': { paramsTuple?: []; params?: {} }
    'beta_3.save_customer': { paramsTuple?: []; params?: {} }
    'lines.index': { paramsTuple?: []; params?: {} }
    'lines.store': { paramsTuple?: []; params?: {} }
    'lines.disconnect': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.index': { paramsTuple?: []; params?: {} }
    'ai_accounts.orchestra': { paramsTuple?: []; params?: {} }
    'ai_accounts.store': { paramsTuple?: []; params?: {} }
    'ai_accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.order': { paramsTuple?: []; params?: {} }
    'ai_accounts.spread': { paramsTuple?: []; params?: {} }
    'ai_accounts.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.login_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.login_start': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.login_verify': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'orders.save_routing': { paramsTuple?: []; params?: {} }
    'orders.refresh_groups': { paramsTuple?: []; params?: {} }
    'account.logout': { paramsTuple?: []; params?: {} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.version': { paramsTuple?: []; params?: {} }
    'dashboard.access': { paramsTuple?: []; params?: {} }
    'dashboard.set_access_domain': { paramsTuple?: []; params?: {} }
    'dashboard.unset_access_domain': { paramsTuple?: []; params?: {} }
    'dashboard.contact_cleanup_preview': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup': { paramsTuple?: []; params?: {} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.usage_runs': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.search_messages': { paramsTuple?: []; params?: {} }
    'dashboard.contact_read': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_read_state': { paramsTuple?: []; params?: {} }
    'dashboard.contact_mode': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.contact_exclusion': { paramsTuple?: []; params?: {} }
    'dashboard.contact_role': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.send_message': { paramsTuple?: []; params?: {} }
    'dashboard.media_retry': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.react_message': { paramsTuple?: []; params?: {} }
    'dashboard.connect': { paramsTuple?: []; params?: {} }
    'dashboard.disconnect': { paramsTuple?: []; params?: {} }
    'dashboard.settings': { paramsTuple?: []; params?: {} }
    'backup.status': { paramsTuple?: []; params?: {} }
    'backup.save': { paramsTuple?: []; params?: {} }
    'backup.connect': { paramsTuple?: []; params?: {} }
    'backup.callback': { paramsTuple?: []; params?: {} }
    'backup.disconnect': { paramsTuple?: []; params?: {} }
    'backup.run': { paramsTuple?: []; params?: {} }
    'backup.list': { paramsTuple?: []; params?: {} }
    'backup.restore': { paramsTuple?: []; params?: {} }
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
    'instagram.status': { paramsTuple?: []; params?: {} }
    'instagram.save': { paramsTuple?: []; params?: {} }
    'instagram.disconnect': { paramsTuple?: []; params?: {} }
    'instagram.connect': { paramsTuple?: []; params?: {} }
    'instagram.callback': { paramsTuple?: []; params?: {} }
    'instagram.page': { paramsTuple?: []; params?: {} }
    'instagram_content.page': { paramsTuple?: []; params?: {} }
    'instagram_content.state': { paramsTuple?: []; params?: {} }
    'instagram_content.upload': { paramsTuple?: []; params?: {} }
    'instagram_content.posts': { paramsTuple?: []; params?: {} }
    'instagram_content.create': { paramsTuple?: []; params?: {} }
    'instagram_content.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.retry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.remove': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.insights': { paramsTuple?: []; params?: {} }
    'instagram_content.performance': { paramsTuple?: []; params?: {} }
    'instagram_content.children': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.caption': { paramsTuple?: []; params?: {} }
    'instagram_content.analysis': { paramsTuple?: []; params?: {} }
    'instagram_content.analyze': { paramsTuple?: []; params?: {} }
    'instagram.comments': { paramsTuple?: []; params?: {} }
    'instagram.comments_count': { paramsTuple?: []; params?: {} }
    'instagram.reply_comment': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram.ai_comment': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.mcp_create': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_delete': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
  }
  GET: {
    'account.login': { paramsTuple?: []; params?: {} }
    'instagram.verify': { paramsTuple?: []; params?: {} }
    'instagram_content.media': { paramsTuple: [ParamValue]; params: {'name': ParamValue} }
    'account.setup': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'beta3': { paramsTuple?: []; params?: {} }
    'beta_3.catalog': { paramsTuple?: []; params?: {} }
    'beta_3.examples': { paramsTuple?: []; params?: {} }
    'beta_3.orders': { paramsTuple?: []; params?: {} }
    'beta_3.mcp': { paramsTuple?: []; params?: {} }
    'beta_3.room': { paramsTuple?: []; params?: {} }
    'beta_3.skill': { paramsTuple?: []; params?: {} }
    'beta_3.recap_status': { paramsTuple?: []; params?: {} }
    'beta_3.weights': { paramsTuple?: []; params?: {} }
    'beta_3.policy': { paramsTuple?: []; params?: {} }
    'beta_3.jev': { paramsTuple?: []; params?: {} }
    'beta_3.jev_decisions': { paramsTuple?: []; params?: {} }
    'beta_3.rules': { paramsTuple?: []; params?: {} }
    'beta_3.tests': { paramsTuple?: []; params?: {} }
    'beta_3.customer': { paramsTuple?: []; params?: {} }
    'lines.index': { paramsTuple?: []; params?: {} }
    'ai_accounts.index': { paramsTuple?: []; params?: {} }
    'ai_accounts.orchestra': { paramsTuple?: []; params?: {} }
    'ai_accounts.login_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.version': { paramsTuple?: []; params?: {} }
    'dashboard.access': { paramsTuple?: []; params?: {} }
    'dashboard.contact_cleanup_preview': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.usage_runs': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.search_messages': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'backup.status': { paramsTuple?: []; params?: {} }
    'backup.connect': { paramsTuple?: []; params?: {} }
    'backup.callback': { paramsTuple?: []; params?: {} }
    'backup.list': { paramsTuple?: []; params?: {} }
    'production.index': { paramsTuple?: []; params?: {} }
    'payment_methods.index': { paramsTuple?: []; params?: {} }
    'skill_edits.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.codex_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.shared_mcp_callback': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'mcp.callback': { paramsTuple: [ParamValue]; params: {'loginId': ParamValue} }
    'mcp.callback.withId': { paramsTuple: [ParamValue,ParamValue]; params: {'loginId': ParamValue,'callbackId': ParamValue} }
    'instagram.status': { paramsTuple?: []; params?: {} }
    'instagram.connect': { paramsTuple?: []; params?: {} }
    'instagram.callback': { paramsTuple?: []; params?: {} }
    'instagram.page': { paramsTuple?: []; params?: {} }
    'instagram_content.page': { paramsTuple?: []; params?: {} }
    'instagram_content.state': { paramsTuple?: []; params?: {} }
    'instagram_content.posts': { paramsTuple?: []; params?: {} }
    'instagram_content.insights': { paramsTuple?: []; params?: {} }
    'instagram_content.performance': { paramsTuple?: []; params?: {} }
    'instagram_content.children': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.analysis': { paramsTuple?: []; params?: {} }
    'instagram.comments': { paramsTuple?: []; params?: {} }
    'instagram.comments_count': { paramsTuple?: []; params?: {} }
  }
  HEAD: {
    'account.login': { paramsTuple?: []; params?: {} }
    'instagram.verify': { paramsTuple?: []; params?: {} }
    'instagram_content.media': { paramsTuple: [ParamValue]; params: {'name': ParamValue} }
    'account.setup': { paramsTuple?: []; params?: {} }
    'account.callback': { paramsTuple?: []; params?: {} }
    'dashboard': { paramsTuple?: []; params?: {} }
    'settings': { paramsTuple?: []; params?: {} }
    'orders': { paramsTuple?: []; params?: {} }
    'beta3': { paramsTuple?: []; params?: {} }
    'beta_3.catalog': { paramsTuple?: []; params?: {} }
    'beta_3.examples': { paramsTuple?: []; params?: {} }
    'beta_3.orders': { paramsTuple?: []; params?: {} }
    'beta_3.mcp': { paramsTuple?: []; params?: {} }
    'beta_3.room': { paramsTuple?: []; params?: {} }
    'beta_3.skill': { paramsTuple?: []; params?: {} }
    'beta_3.recap_status': { paramsTuple?: []; params?: {} }
    'beta_3.weights': { paramsTuple?: []; params?: {} }
    'beta_3.policy': { paramsTuple?: []; params?: {} }
    'beta_3.jev': { paramsTuple?: []; params?: {} }
    'beta_3.jev_decisions': { paramsTuple?: []; params?: {} }
    'beta_3.rules': { paramsTuple?: []; params?: {} }
    'beta_3.tests': { paramsTuple?: []; params?: {} }
    'beta_3.customer': { paramsTuple?: []; params?: {} }
    'lines.index': { paramsTuple?: []; params?: {} }
    'ai_accounts.index': { paramsTuple?: []; params?: {} }
    'ai_accounts.orchestra': { paramsTuple?: []; params?: {} }
    'ai_accounts.login_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'directory': { paramsTuple?: []; params?: {} }
    'contact_directory.index': { paramsTuple?: []; params?: {} }
    'contact_directory.export': { paramsTuple?: []; params?: {} }
    'orders.routing': { paramsTuple?: []; params?: {} }
    'dashboard.status': { paramsTuple?: []; params?: {} }
    'dashboard.version': { paramsTuple?: []; params?: {} }
    'dashboard.access': { paramsTuple?: []; params?: {} }
    'dashboard.contact_cleanup_preview': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup_status': { paramsTuple?: []; params?: {} }
    'dashboard.usage': { paramsTuple?: []; params?: {} }
    'dashboard.usage_runs': { paramsTuple?: []; params?: {} }
    'dashboard.quotas': { paramsTuple?: []; params?: {} }
    'dashboard.trace': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_list': { paramsTuple?: []; params?: {} }
    'dashboard.search_messages': { paramsTuple?: []; params?: {} }
    'dashboard.ai_exclusions': { paramsTuple?: []; params?: {} }
    'dashboard.messages': { paramsTuple?: []; params?: {} }
    'dashboard.media': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'backup.status': { paramsTuple?: []; params?: {} }
    'backup.connect': { paramsTuple?: []; params?: {} }
    'backup.callback': { paramsTuple?: []; params?: {} }
    'backup.list': { paramsTuple?: []; params?: {} }
    'production.index': { paramsTuple?: []; params?: {} }
    'payment_methods.index': { paramsTuple?: []; params?: {} }
    'skill_edits.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.codex_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.claude_status': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_status': { paramsTuple?: []; params?: {} }
    'dashboard.shared_mcp_callback': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'mcp.callback': { paramsTuple: [ParamValue]; params: {'loginId': ParamValue} }
    'mcp.callback.withId': { paramsTuple: [ParamValue,ParamValue]; params: {'loginId': ParamValue,'callbackId': ParamValue} }
    'instagram.status': { paramsTuple?: []; params?: {} }
    'instagram.connect': { paramsTuple?: []; params?: {} }
    'instagram.callback': { paramsTuple?: []; params?: {} }
    'instagram.page': { paramsTuple?: []; params?: {} }
    'instagram_content.page': { paramsTuple?: []; params?: {} }
    'instagram_content.state': { paramsTuple?: []; params?: {} }
    'instagram_content.posts': { paramsTuple?: []; params?: {} }
    'instagram_content.insights': { paramsTuple?: []; params?: {} }
    'instagram_content.performance': { paramsTuple?: []; params?: {} }
    'instagram_content.children': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.analysis': { paramsTuple?: []; params?: {} }
    'instagram.comments': { paramsTuple?: []; params?: {} }
    'instagram.comments_count': { paramsTuple?: []; params?: {} }
  }
  POST: {
    'instagram.receive': { paramsTuple?: []; params?: {} }
    'account.login_post': { paramsTuple?: []; params?: {} }
    'account.setup_post': { paramsTuple?: []; params?: {} }
    'beta_3.import_catalog': { paramsTuple?: []; params?: {} }
    'beta_3.sync_catalog': { paramsTuple?: []; params?: {} }
    'beta_3.add_example': { paramsTuple?: []; params?: {} }
    'beta_3.approve_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.paid_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.settle_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.paid_amount': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.ready_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.delivered_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.cancel_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.resend_group': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.save_mcp': { paramsTuple?: []; params?: {} }
    'beta_3.save_spec': { paramsTuple?: []; params?: {} }
    'beta_3.update_skill': { paramsTuple?: []; params?: {} }
    'beta_3.start_recap': { paramsTuple?: []; params?: {} }
    'beta_3.save_weights': { paramsTuple?: []; params?: {} }
    'beta_3.save_jev': { paramsTuple?: []; params?: {} }
    'beta_3.test_jev': { paramsTuple?: []; params?: {} }
    'beta_3.mark_jev_decision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.save_policy': { paramsTuple?: []; params?: {} }
    'beta_3.add_rule': { paramsTuple?: []; params?: {} }
    'beta_3.correction': { paramsTuple?: []; params?: {} }
    'beta_3.run_tests': { paramsTuple?: []; params?: {} }
    'beta_3.save_customer': { paramsTuple?: []; params?: {} }
    'lines.store': { paramsTuple?: []; params?: {} }
    'lines.disconnect': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.store': { paramsTuple?: []; params?: {} }
    'ai_accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.order': { paramsTuple?: []; params?: {} }
    'ai_accounts.spread': { paramsTuple?: []; params?: {} }
    'ai_accounts.login_start': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.login_verify': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'orders.refresh_groups': { paramsTuple?: []; params?: {} }
    'account.logout': { paramsTuple?: []; params?: {} }
    'dashboard.set_access_domain': { paramsTuple?: []; params?: {} }
    'dashboard.unset_access_domain': { paramsTuple?: []; params?: {} }
    'dashboard.chat_cleanup': { paramsTuple?: []; params?: {} }
    'dashboard.contact_read': { paramsTuple?: []; params?: {} }
    'dashboard.contacts_read_state': { paramsTuple?: []; params?: {} }
    'dashboard.contact_mode': { paramsTuple?: []; params?: {} }
    'dashboard.contact_exclusion': { paramsTuple?: []; params?: {} }
    'dashboard.contact_role': { paramsTuple?: []; params?: {} }
    'dashboard.send_message': { paramsTuple?: []; params?: {} }
    'dashboard.media_retry': { paramsTuple?: []; params?: {} }
    'dashboard.react_message': { paramsTuple?: []; params?: {} }
    'dashboard.connect': { paramsTuple?: []; params?: {} }
    'dashboard.disconnect': { paramsTuple?: []; params?: {} }
    'dashboard.settings': { paramsTuple?: []; params?: {} }
    'backup.save': { paramsTuple?: []; params?: {} }
    'backup.disconnect': { paramsTuple?: []; params?: {} }
    'backup.run': { paramsTuple?: []; params?: {} }
    'backup.restore': { paramsTuple?: []; params?: {} }
    'payments.create': { paramsTuple?: []; params?: {} }
    'skill_edits.create': { paramsTuple?: []; params?: {} }
    'dashboard.oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.claude_oauth_verify': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_start': { paramsTuple?: []; params?: {} }
    'dashboard.mcp_oauth_verify': { paramsTuple?: []; params?: {} }
    'instagram.save': { paramsTuple?: []; params?: {} }
    'instagram.disconnect': { paramsTuple?: []; params?: {} }
    'instagram_content.upload': { paramsTuple?: []; params?: {} }
    'instagram_content.create': { paramsTuple?: []; params?: {} }
    'instagram_content.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.retry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.remove': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram_content.caption': { paramsTuple?: []; params?: {} }
    'instagram_content.analyze': { paramsTuple?: []; params?: {} }
    'instagram.reply_comment': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'instagram.ai_comment': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.mcp_create': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'beta_3.remove_example': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.remove_rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'beta_3.remove_test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'ai_accounts.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'payment_methods.delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.skill_delete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'dashboard.mcp_delete': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
  }
  PUT: {
    'orders.save_routing': { paramsTuple?: []; params?: {} }
    'production.save': { paramsTuple?: []; params?: {} }
    'payments.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}