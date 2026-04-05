# Run inside Canvas container: docker exec canvas-web-1 bash -lc "cd /usr/src/app && bundle exec rails runner /path/to/this.rb"
t = User.find(1).access_tokens.create!(purpose: 'FlowStateASL_local_dev', workflow_state: 'active')
puts t.full_token
