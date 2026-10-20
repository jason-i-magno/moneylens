export default function EmptyState({ icon = '\u{1F4AD}', message, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <p>{message}</p>
      {action && action}
    </div>
  );
}
