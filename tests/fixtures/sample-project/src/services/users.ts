export interface User {
  id: string;
  name: string;
  email: string;
}

export function getUser(id: string): User | null {
  if (!id) {
    return null;
  }

  return {
    id,
    name: "Sample User",
    email: "user@example.com",
  };
}

export function listUsers(): User[] {
  return [];
}
