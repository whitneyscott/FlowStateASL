export interface PromptConfig {
  courseId: string;
  resourceLinkId: string;
  configJson: string;
  resourceLinkTitle?: string | null;
  updatedAt: Date;
}

export interface IConfigRepository {
  getConfig(
    courseId: string,
    resourceLinkId: string
  ): Promise<PromptConfig | null>;
  saveConfig(config: PromptConfig): Promise<void>;
  deleteConfig(courseId: string, resourceLinkId: string): Promise<void>;
}
